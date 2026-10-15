import { spawnSync } from 'node:child_process';
import { mkdir, copyFile, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const appConfig = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const executableName = `${appConfig.productName}.exe`;
const archiveName = `${appConfig.productName}-Windows-x64.zip`;
if (releaseVersion !== appConfig.version) throw new Error('Frontend and native application versions do not match.');
const tools = join(root, '.build-tools');
const exists = async path => { try { await stat(path); return true; } catch { return false; } };
if (process.platform !== 'win32') throw new Error('Build this Windows app on Windows, or use the documented CI build.');
const localRust = await exists(join(tools, 'cargo/bin/cargo.exe'));
const targetArg = process.argv.find(arg => arg.startsWith('--target='))?.split('=')[1];
const target = targetArg || (localRust ? 'x86_64-pc-windows-gnu' : 'x86_64-pc-windows-msvc');
if (!['x86_64-pc-windows-gnu', 'x86_64-pc-windows-msvc'].includes(target)) throw new Error('Unsupported Windows build target.');
const env = { ...process.env };
const pathKey = Object.keys(env).find(name => name.toLowerCase() === 'path') || 'PATH';
env[pathKey] = `${dirname(process.execPath)};${env[pathKey] || ''}`;
if (localRust) {
  env.CARGO_HOME = join(tools, 'cargo'); env.RUSTUP_HOME = join(tools, 'rustup');
  env[pathKey] = `${join(tools, 'cargo/bin')};C:\\MinGW\\bin;${env[pathKey]}`;
}
env.CARGO_BUILD_JOBS ||= '8';
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd:root, env, stdio:'inherit', windowsHide:true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} failed (${result.status}).`);
  return result;
}
const cli = join(root, 'node_modules/@tauri-apps/cli/tauri.js');
const cargoManifest = join(root, 'src-tauri/Cargo.toml');
const originalManifest = await readFile(cargoManifest, 'utf8');
try {
  // GNU's PE DLL export limit is irrelevant to the desktop executable. Keep the
  // mobile static/dynamic library types in source, but build only its Rust library
  // dependency for this desktop build. Restore the cross-platform manifest always.
  if (!process.argv.includes('--package-only')) {
    if (target.endsWith('-gnu')) await writeFile(cargoManifest, originalManifest.replace(/crate-type\s*=\s*\[[^\]]*\]/, 'crate-type = ["rlib"]'));
    run(process.execPath, [cli, 'build', '--no-bundle', '--target', target, '--ci']);
  }
} finally {
  if (target.endsWith('-gnu') && !process.argv.includes('--package-only')) await writeFile(cargoManifest, originalManifest);
}
const output = join(root, 'release');
await mkdir(output, {recursive:true});
const exe = join(output, executableName);
await copyFile(join(root, 'src-tauri/target', target, 'release/fastdict.exe'), exe);
const files = [executableName, 'THIRD_PARTY_NOTICES.md', 'README-Windows.txt'];
// Include MinGW runtime DLLs only when the final executable actually imports them.
const inspection = spawnSync('objdump', ['-p', exe], { env, encoding:'utf8', windowsHide:true, maxBuffer:64*1024*1024 });
if (target.endsWith('-gnu') && inspection.status !== 0) throw new Error('Unable to inspect Windows DLL dependencies. Ensure MinGW objdump is available.');
if (inspection.status === 0) {
  for (const name of ['libgcc_s_seh-1.dll','libstdc++-6.dll','libwinpthread-1.dll']) {
    if (inspection.stdout.includes(`DLL Name: ${name}`)) { await copyFile(join('C:/MinGW/bin',name),join(output,name)); files.push(name); }
  }
  if (inspection.stdout.includes('DLL Name: WebView2Loader.dll')) {
    const buildFolder=join(root,'src-tauri/target',target,'release/build');
    const loaderFolders=(await readdir(buildFolder)).filter(name=>name.startsWith('webview2-com-sys-'));
    let loader;
    for(const folder of loaderFolders){const candidate=join(buildFolder,folder,'out/x64/WebView2Loader.dll');if(await exists(candidate)){loader=candidate;break;}}
    if(!loader)throw new Error('WebView2Loader.dll was not found in build outputs.');
    await copyFile(loader,join(output,'WebView2Loader.dll'));
    await copyFile(loader,join(root,'src-tauri/target',target,'release/WebView2Loader.dll'));
    files.push('WebView2Loader.dll');
  }
}
await copyFile(join(root,'THIRD_PARTY_NOTICES.md'),join(output,'THIRD_PARTY_NOTICES.md'));
await writeFile(join(output,'README-Windows.txt'), `${appConfig.productName} ${releaseVersion} — Windows 桌面应用\n\n1. 解压整个 ZIP，保持 ${executableName} 和附带 DLL 在同一文件夹，再双击 ${executableName}。\n2. 首次打开没有预设服务。添加 API 服务并填写地址、模型和密钥；或选择“ChatGPT 订阅”，点击 Continue with ChatGPT，在系统浏览器为 FastLingo 登录并授权。无需安装 Codex 或填写 API Key。\n3. 选择 OCR 与目标语言。在任意应用按 Ctrl+Shift+S，拖动框选文字，松开鼠标。\n4. 侧栏自动执行本地 OCR，并逐步显示翻译服务返回的译文。\n\nCtrl+Shift+D：翻译已经复制的文字。\nEsc：取消框选或当前翻译。\nCtrl+Alt+Q：退出应用（原生快捷键，不依赖页面）。\n系统标题栏的 X：默认直接退出，可在偏好设置改为最小化到托盘。界面内“最小化到托盘”：保持后台运行。\n托盘右键：重新打开或退出。开机启动默认关闭，可在偏好设置开启。\n\nChatGPT 订阅使用官方 Sign in with ChatGPT，由 FastLingo 独立管理授权；符合条件的翻译请求使用你的 ChatGPT 套餐或积分。默认模型 gpt-6-luna，以所选账号的实时模型目录为准。可选择已保存账号、添加账号、刷新连接、管理用量或断开连接。刷新仅检查连接和模型，不发送翻译文本。\n首次启用套餐时请阅读应用内用量提示。达到限制后，打开“管理用量”或 https://chatgpt.com/settings/usage 查看；应用不会自动切换到 API Key 计费。iOS、Android 和浏览器预览继续使用 API 服务。\n\n升级保留原有设置、历史和系统凭据中的 API Key。旧 Codex 服务配置保留，但须在 FastLingo 中重新授权；新版本不读取 Codex 凭据，也不启动 Codex CLI。\nOAuth 凭据由原生端加密保存在本机，加密密钥保存在系统凭据库。断开连接会尝试撤销可续期会话并清除本机令牌；如未确认远程撤销，请按应用提示到 ChatGPT 设置断开连接。\n运行需要 Windows 10/11 与 Microsoft Edge WebView2 Runtime。\nOCR 资源内置，识别在本机完成；识别后的文字发送至所选翻译服务，翻译需要网络及可用的服务权限。\n本地构建未签名。\n`, 'utf8');
run(join(process.env.SystemRoot || 'C:/Windows','System32/tar.exe'), ['-a','-c','-f',join(output,archiveName),'-C',output,...files]);
const versionedArchive = `${appConfig.productName}-Windows-x64-${releaseVersion}.zip`;
await copyFile(join(output,archiveName),join(output,versionedArchive));
const manifest = { version:releaseVersion, target, artifacts:[] };
for (const name of [executableName,archiveName,versionedArchive]) {
  const bytes = await readFile(join(output,name)); manifest.artifacts.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
if (process.argv.includes('--installer')) {
  const resources = Object.fromEntries(files.filter(name => name !== executableName && name !== 'WebView2Loader.dll').map(name => [join(output, name), name]));
  // Tauri includes GNU's WebView2Loader from the target directory itself.
  // Other imported runtime DLLs and notices must also ship in the installer.
  const installerConfig = { bundle: {
    useLocalToolsDir: true,
    resources,
    windows: { nsis: { installMode: 'currentUser', languages: ['SimpChinese', 'English'] } },
  } };
  run(process.execPath,[cli,'bundle','--target',target,'--bundles','nsis','--ci','--config',JSON.stringify(installerConfig)]);
  const folder=join(root,'src-tauri/target',target,'release/bundle/nsis');
  const setups=(await readdir(folder)).filter(name=>name.startsWith(`${appConfig.productName}_${releaseVersion}_`) && name.endsWith('-setup.exe'));
  if(setups.length !== 1) throw new Error('A unique Windows installer for this version was not produced.');
  const setup=setups[0];
  await copyFile(join(folder,setup),join(output,setup));
  const bytes=await readFile(join(output,setup));manifest.artifacts.push({name:setup,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
process.stdout.write(`Windows app ready: ${exe}\n`);
