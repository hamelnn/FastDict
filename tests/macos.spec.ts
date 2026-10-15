import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface MacCall { command: string; args: Record<string, unknown>; }
interface MacFixture {
  calls: MacCall[];
  screenSharingAttempts: number;
  setPermission: (status: 'granted' | 'denied') => void;
  emit: (event: string, payload: unknown) => void;
}

test.use({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', viewport: { width: 1120, height: 780 } });

async function installMac(page: Page, status: 'granted' | 'denied' = 'denied', grantOnRequest = false): Promise<void> {
  await page.addInitScript(({ status, grantOnRequest }) => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
    localStorage.setItem('fastdict.v1.preferences', JSON.stringify({ sourceLang: 'auto', targetLang: 'zh-CN', ocrLang: 'eng', autoTranslate: false, activeProviderId: 'openai' }));
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, Set<number>>();
    let nextId = 1;
    let permissionStatus = status;
    const permission = () => ({ supported: true, granted: permissionStatus === 'granted', status: permissionStatus });
    const fixture: MacFixture = {
      calls: [], screenSharingAttempts: 0,
      setPermission: next => { permissionStatus = next; },
      emit: (event, payload) => { for (const id of listeners.get(event) || []) callbacks.get(id)?.({ event, id, payload }); },
    };
    Object.assign(window, {
      e2eMac: fixture,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: (callback: (event: unknown) => void) => { const id = nextId++; callbacks.set(id, callback); return id; },
        unregisterCallback: (id: number) => { callbacks.delete(id); },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          fixture.calls.push({ command, args: { ...args } });
          if (command === 'plugin:event|listen') {
            const event = args.event as string, id = args.handler as number;
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(id); return id;
          }
          if (command === 'plugin:event|unlisten') { listeners.get(args.event as string)?.delete(args.eventId as number); return; }
          if (command === 'get_screen_permission') return permission();
          if (command === 'request_screen_permission') { if (grantOnRequest) permissionStatus = 'granted'; return permission(); }
          if (command === 'get_api_key') return null;
          if (command === 'read_clipboard') return 'Mac clipboard text';
          if (command === 'get_shortcut_status') return { captureShortcut: 'Alt+Super+S', clipboardShortcut: 'Alt+Super+V', quitShortcut: 'Alt+Super+Q', platform: 'macos', error: null };
          if (['frontend_ready', 'report_boot_error', 'open_screen_permission_settings', 'start_capture', 'hide_window', 'expand_window', 'quit_app'].includes(command)) return;
          throw new Error(`Unexpected native Mac command: ${command}`);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string, id: number) => { listeners.get(event)?.delete(id); callbacks.delete(id); } },
    });
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: () => {
      fixture.screenSharingAttempts++;
      throw new Error('The native Mac app must never request browser screen sharing');
    } });
  }, { status, grantOnRequest });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).toBeVisible();
  await expect.poll(async () => (await calls(page, 'get_screen_permission')).length).toBeGreaterThan(0);
}

async function calls(page: Page, command: string): Promise<MacCall[]> {
  return page.evaluate(command => (window as unknown as { e2eMac: MacFixture }).e2eMac.calls.filter(call => call.command === command), command);
}

async function emit(page: Page, event: string, payload: unknown): Promise<void> {
  await page.evaluate(({ event, payload }) => (window as unknown as { e2eMac: MacFixture }).e2eMac.emit(event, payload), { event, payload });
}

test('shows native Mac shortcuts and read-only permission status without prompting on startup', async ({ page }) => {
  await installMac(page);
  await expect(page.locator('.capture-button kbd')).toHaveText('⌥⌘S');
  await expect(page.getByRole('button', { name: /^粘贴文本/ }).locator('kbd')).toHaveText('⌥⌘V');
  await expect(page.getByRole('button', { name: '隐藏到菜单栏', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '最小化到托盘', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '浏览器截图体验', exact: true })).toHaveCount(0);
  expect(await calls(page, 'request_screen_permission')).toHaveLength(0);
  expect(await calls(page, 'open_screen_permission_settings')).toHaveLength(0);
  await page.getByRole('button', { name: /^截图翻译/ }).click();
  await expect(page.getByRole('region', { name: 'macOS 屏幕录制权限' })).toContainText('尚未授权');
  expect(await calls(page, 'start_capture')).toHaveLength(0);
  expect(await calls(page, 'request_screen_permission')).toHaveLength(0);
  expect(await page.evaluate(() => (window as unknown as { e2eMac: MacFixture }).e2eMac.screenSharingAttempts)).toBe(0);
});

test('requests permission only on an explicit action, opens settings and rechecks before native capture', async ({ page }) => {
  await installMac(page);
  await page.getByRole('button', { name: /^截图翻译/ }).click();
  const panel = page.getByRole('region', { name: 'macOS 屏幕录制权限' });
  await panel.getByRole('button', { name: '授予录屏权限', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'request_screen_permission')).length).toBe(1);
  await expect(panel).toContainText('请在系统设置中允许轻译录屏');
  await panel.getByRole('button', { name: '打开系统设置', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'open_screen_permission_settings')).length).toBe(1);
  await page.evaluate(() => (window as unknown as { e2eMac: MacFixture }).e2eMac.setPermission('granted'));
  await panel.getByRole('button', { name: '重新检查', exact: true }).click();
  await expect(panel.locator('.permission-badge')).toHaveText('已授权');
  await expect(panel.getByRole('button', { name: '授予录屏权限', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '开始截图', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'start_capture')).length).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { e2eMac: MacFixture }).e2eMac.screenSharingAttempts)).toBe(0);
});

test('updates a successful permission request immediately and respects menu bar actions and clipboard input', async ({ page }) => {
  await installMac(page, 'denied', true);
  await page.getByRole('button', { name: '设置录屏权限', exact: true }).click();
  const panel = page.getByRole('region', { name: 'macOS 屏幕录制权限' });
  await panel.getByRole('button', { name: '授予录屏权限', exact: true }).click();
  await expect(panel.locator('.permission-badge')).toHaveText('已授权');
  await page.getByRole('button', { name: '即时翻译', exact: true }).click();
  await page.getByRole('button', { name: /^粘贴文本/ }).click();
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).toHaveValue('Mac clipboard text');
  await expect.poll(async () => (await calls(page, 'read_clipboard')).length).toBe(1);
  await page.getByRole('button', { name: '隐藏到菜单栏', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'hide_window')).length).toBe(1);
  await emit(page, 'fastdict://navigate', 'settings');
  await expect(panel).toBeVisible();
  await expect(page.locator('.shortcut-row').filter({ hasText: '桌面全局截图翻译' }).locator('kbd')).toHaveText('⌥⌘S');
  await expect(page.locator('.shortcut-row').filter({ hasText: '桌面全局剪贴板翻译' }).locator('kbd')).toHaveText('⌥⌘V');
  await expect(page.locator('.mac-quit-hint')).toHaveText('⌘Q / ⌥⌘Q');
  await page.getByRole('button', { name: '退出轻译', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'quit_app')).length).toBe(1);
});

test('routes a global native permission denial to setup without requesting access or browser sharing', async ({ page }) => {
  await installMac(page, 'granted');
  await page.evaluate(() => (window as unknown as { e2eMac: MacFixture }).e2eMac.setPermission('denied'));
  await emit(page, 'fastdict://error', '请开启 macOS 屏幕录制权限。');
  await expect(page.getByRole('region', { name: 'macOS 屏幕录制权限' })).toContainText('尚未授权');
  expect(await calls(page, 'request_screen_permission')).toHaveLength(0);
  expect(await page.evaluate(() => (window as unknown as { e2eMac: MacFixture }).e2eMac.screenSharingAttempts)).toBe(0);
});

test('keeps Command-Q guidance and direct native exit available when the Mac workspace module fails', async ({ page }) => {
  let injected = false;
  await page.route(url => url.pathname === '/src/App.tsx', route => {
    injected = true;
    return route.fulfill({ status: 200, contentType: 'text/javascript', body: 'throw new Error("Synthetic Mac boot fault");export default function(){return null;}' });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
    const calls: MacCall[] = [];
    Object.assign(window, { e2eMac: { calls }, __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown> = {}) => { calls.push({ command, args }); } } });
  });
  await page.goto('/');
  const recovery = page.locator('#fastdict-boot-error');
  await expect(recovery).toBeVisible();
  expect(injected).toBe(true);
  await expect(recovery).toContainText('⌘Q 退出应用；⌥⌘Q 可立即退出。');
  await expect(recovery).not.toContainText('Ctrl + Alt + Q');
  await recovery.getByRole('button', { name: '退出应用', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'quit_app')).length).toBe(1);
});

async function savePreview(page: Page, info: TestInfo, filename: string): Promise<void> {
  const path = info.outputPath(filename);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(`Simulated native Mac: ${filename}`, { path, contentType: 'image/png' });
  await mkdir(resolve('native-test-results'), { recursive: true });
  await copyFile(path, resolve('native-test-results', filename));
}

test('saves clearly simulated Mac workspace and permission previews without API calls', async ({ page }, info) => {
  await installMac(page, 'granted');
  await page.getByRole('textbox', { name: '待翻译文本' }).fill('The best journeys begin with a clear view.');
  await expect(page.getByText('本机识别已就绪 · 松开即翻译', { exact: true })).toBeVisible({ timeout: 60_000 });
  await savePreview(page, info, 'macos-workspace-preview.png');
  await page.evaluate(() => (window as unknown as { e2eMac: MacFixture }).e2eMac.setPermission('denied'));
  await emit(page, 'fastdict://navigate', 'settings');
  await expect(page.getByRole('region', { name: 'macOS 屏幕录制权限' })).toContainText('尚未授权');
  await savePreview(page, info, 'macos-permissions-preview.png');
  expect((await page.evaluate(() => (window as unknown as { e2eMac: MacFixture }).e2eMac.calls)).some(call => call.command.startsWith('plugin:http|'))).toBe(false);
});
