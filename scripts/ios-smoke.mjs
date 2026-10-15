import { spawnSync } from 'node:child_process';
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'release/ios');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function run(command, args, timeout = 60_000) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${basename(command)} ${args[0]} failed: ${result.stderr?.trim() || result.error?.message || result.status}`);
  }
  return result.stdout?.trim() || '';
}

function simctl(args, timeout) { return run('/usr/bin/xcrun', ['simctl', ...args], timeout); }

function chooseDevice(inventory, arch) {
  const candidates = [];
  for (const runtime of inventory.runtimes || []) {
    if (!runtime.isAvailable || !runtime.identifier?.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-')) continue;
    if (Number.parseInt(runtime.version, 10) < 15) continue;
    if (Array.isArray(runtime.supportedArchitectures) && !runtime.supportedArchitectures.includes(arch)) continue;
    for (const device of inventory.devices?.[runtime.identifier] || []) {
      if (!device.isAvailable || !device.name?.startsWith('iPhone')) continue;
      const type = device.deviceTypeIdentifier || inventory.devicetypes?.find(item => item.name === device.name)?.identifier;
      if (type?.startsWith('com.apple.CoreSimulator.SimDeviceType.iPhone-')) candidates.push({ runtime, type, name: device.name });
    }
  }
  candidates.sort((a, b) => b.runtime.version.localeCompare(a.runtime.version, undefined, { numeric: true }));
  if (!candidates.length) throw new Error(`No available iPhone simulator runtime for ${arch}; no runtime will be downloaded automatically.`);
  return candidates[0];
}

async function main() {
  // This smoke test creates and deletes one disposable simulator on a hosted
  // GitHub runner. It must never operate on a developer's existing devices.
  if (process.platform !== 'darwin' || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' || process.env.FASTDICT_IOS_SMOKE !== 'true') {
    throw new Error('iOS launch smoke test is restricted to the explicitly enabled macOS GitHub CI job.');
  }
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : null;
  if (!arch) throw new Error(`Unsupported simulator host architecture: ${process.arch}`);
  const target = arch === 'arm64' ? 'aarch64-sim' : 'x86_64';
  const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  if (config.identifier !== 'app.fastdict.translate') throw new Error('Unexpected app identifier; refusing to launch a different app.');
  const manifest = JSON.parse(await readFile(join(output, `manifest-${target}.json`), 'utf8'));
  if (manifest.kind !== 'ios-simulator-app' || manifest.target !== target || manifest.version !== config.version || manifest.deviceInstallable !== false || manifest.artifacts?.length !== 1) {
    throw new Error('Simulator artifact manifest does not match this build and host architecture.');
  }
  const artifact = manifest.artifacts[0];
  if (basename(artifact.name) !== artifact.name || !artifact.name.endsWith('.app.zip')) throw new Error('Invalid simulator archive name.');
  const archive = join(output, artifact.name);
  const bytes = await readFile(archive);
  if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Simulator archive checksum mismatch.');

  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, 'smoke-temp-'));
  let createdDevice;
  const report = { version: config.version, target, scope: 'simulator_process_launch_and_screenshot', deviceTest: 'not_run', uiVerification: 'not_run', launchSucceeded: false, screenshot: null, cleanup: 'not_started' };
  try {
    run('/usr/bin/ditto', ['-x', '-k', archive, temporary]);
    const apps = (await readdir(temporary, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
    if (apps.length !== 1) throw new Error('Expected one app bundle in the verified simulator archive.');
    const app = join(temporary, apps[0].name);
    const plist = key => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Info.plist')]);
    if (plist('CFBundleIdentifier') !== config.identifier || plist('CFBundleShortVersionString') !== config.version || plist('CFBundleSupportedPlatforms:0') !== 'iPhoneSimulator') throw new Error('Extracted app identity or platform mismatch.');
    const executable = plist('CFBundleExecutable');
    if (!/^[A-Za-z0-9._-]+$/.test(executable) || run('/usr/bin/lipo', ['-archs', join(app, executable)]) !== arch) throw new Error('Simulator executable architecture mismatch.');

    // Use an available iPhone as the template, then create our own device. No
    // booted developer/runner device is erased, shut down, reused or deleted.
    const selection = chooseDevice(JSON.parse(simctl(['list', '--json'])), arch);
    report.device = selection.name;
    report.runtime = selection.runtime.version;
    const name = `FastLingo-Smoke-${process.env.GITHUB_RUN_ID || process.pid}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
    const created = simctl(['create', name, selection.type, selection.runtime.identifier]);
    if (!uuidPattern.test(created)) throw new Error('simctl did not return a device UUID.');
    createdDevice = created;
    simctl(['bootstatus', createdDevice, '-b'], 180_000);
    simctl(['install', createdDevice, app]);
    const launched = simctl(['launch', createdDevice, config.identifier]);
    const launchMatch = /^app\.fastdict\.translate:\s+(\d+)$/m.exec(launched);
    if (!launchMatch) throw new Error('simctl launch did not return the expected app process ID.');
    report.launchSucceeded = true;
    report.launchPid = Number(launchMatch[1]);
    // Allow the WKWebView to initialize before collecting visual evidence.
    await new Promise(resolveDelay => setTimeout(resolveDelay, 12_000));
    const screenshot = join(output, 'simulator-launch.png');
    simctl(['io', createdDevice, 'screenshot', screenshot]);
    const png = await readFile(screenshot);
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Simulator screenshot was not a valid PNG.');
    report.screenshot = 'simulator-launch.png';
    report.screenshotWidth = png.readUInt32BE(16);
    report.screenshotHeight = png.readUInt32BE(20);
    process.stdout.write(`Simulator launch succeeded; captured ${report.screenshotWidth}×${report.screenshotHeight}. This does not verify OCR, translation, or physical-device behavior.\n`);
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (createdDevice && uuidPattern.test(createdDevice)) {
      try { simctl(['shutdown', createdDevice]); } catch (error) { cleanupErrors.push(error.message); }
      try { simctl(['delete', createdDevice]); } catch (error) { cleanupErrors.push(error.message); }
    }
    // Only remove the exact temporary directory returned by mkdtemp above.
    if (temporary.startsWith(output + sep + 'smoke-temp-')) await rm(temporary, { recursive: true, force: true });
    report.cleanup = cleanupErrors.length ? 'warning' : 'completed';
    if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; process.stderr.write(cleanupErrors.join('\n') + '\n'); }
    await writeFile(join(output, 'simulator-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
