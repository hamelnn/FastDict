import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

interface DesktopPreferences {
  closeAction: 'quit' | 'tray';
  launchAtLogin: boolean;
  trayAvailable: boolean;
  autostartAvailable: boolean;
  autostartError?: string;
}
interface NativeCall { command: string; args: Record<string, unknown>; }
interface DesktopFixture {
  calls: NativeCall[];
  failReads: boolean;
  failNextSave: boolean;
  applyBeforeFailure: boolean;
  holdNextSave: boolean;
  releaseSave: () => void;
  changeSystemLaunch: (enabled: boolean) => void;
}

async function installDesktop(page: Page, options: { preferences?: Partial<DesktopPreferences>; failReads?: boolean } = {}) {
  await page.addInitScript(({ preferences, failReads }) => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
    const initial = { closeAction: 'quit', launchAtLogin: false, trayAvailable: true, autostartAvailable: true, ...preferences };
    // This fixture simulates the native store across a page reload. It never
    // invokes Rust, writes a real user profile or changes OS login items.
    let saved: DesktopPreferences = JSON.parse(sessionStorage.getItem('e2e.desktop-preferences') || JSON.stringify(initial));
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, Set<number>>();
    let nextId = 1;
    const state: DesktopFixture = {
      calls: [], failReads: Boolean(failReads), failNextSave: false,
      applyBeforeFailure: false, holdNextSave: false, releaseSave: () => undefined,
      changeSystemLaunch: enabled => {
        saved = { ...saved, launchAtLogin: enabled };
        sessionStorage.setItem('e2e.desktop-preferences', JSON.stringify(saved));
      },
    };
    Object.assign(window, {
      desktopTest: state,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: (callback: (event: unknown) => void) => { const id = nextId++; callbacks.set(id, callback); return id; },
        unregisterCallback: (id: number) => { callbacks.delete(id); },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          state.calls.push({ command, args: { ...args } });
          if (command === 'plugin:event|listen') {
            const event = args.event as string, id = args.handler as number;
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(id); return id;
          }
          if (command === 'plugin:event|unlisten') { listeners.get(args.event as string)?.delete(args.eventId as number); return; }
          if (command === 'get_desktop_preferences') {
            if (state.failReads) throw new Error('无法读取系统登录项');
            return { ...saved };
          }
          if (command === 'set_desktop_preferences') {
            if (Object.keys(args).sort().join(',') !== 'closeAction,launchAtLogin,updateLaunchAtLogin'
              || !['quit', 'tray'].includes(String(args.closeAction)) || typeof args.launchAtLogin !== 'boolean'
              || typeof args.updateLaunchAtLogin !== 'boolean') {
              throw new Error('Expected top-level closeAction, launchAtLogin and updateLaunchAtLogin arguments');
            }
            if (state.holdNextSave) {
              state.holdNextSave = false;
              await new Promise<void>(resolve => { state.releaseSave = resolve; });
            }
            if (!state.failNextSave || state.applyBeforeFailure) {
              saved = { ...saved, closeAction: args.closeAction as 'quit' | 'tray', launchAtLogin: args.updateLaunchAtLogin ? args.launchAtLogin : saved.launchAtLogin };
              sessionStorage.setItem('e2e.desktop-preferences', JSON.stringify(saved));
            }
            if (state.failNextSave) { state.failNextSave = false; throw new Error('系统拒绝开机启动设置'); }
            return { ...saved };
          }
          if (command === 'get_api_key') return null;
          if (command === 'get_shortcut_status') return { captureShortcut: 'Ctrl+Shift+S', clipboardShortcut: 'Ctrl+Shift+D', error: null };
          if (['frontend_ready', 'report_boot_error', 'quit_app', 'hide_window', 'expand_window'].includes(command)) return;
          throw new Error(`Unexpected desktop test IPC: ${command}`);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string, id: number) => { listeners.get(event)?.delete(id); callbacks.delete(id); } },
    });
  }, options);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).toBeVisible();
}

async function calls(page: Page, command: string): Promise<NativeCall[]> {
  return page.evaluate(command => (window as unknown as { desktopTest: DesktopFixture }).desktopTest.calls.filter(call => call.command === command), command);
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: /^偏好设置/ }).click();
  await page.getByRole('button', { name: '高级设置', exact: true }).click();
  const panel = page.getByRole('region', { name: '桌面行为' });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  return panel;
}

test('desktop defaults do not write login items; explicit choices persist and wait for native confirmation', async ({ page }) => {
  await installDesktop(page);
  expect(await calls(page, 'get_desktop_preferences')).toHaveLength(0);
  expect(await calls(page, 'set_desktop_preferences')).toHaveLength(0);
  let panel = await openSettings(page);
  await expect(panel.getByLabel('关闭主窗口时', { exact: true })).toHaveValue('quit');
  await expect(panel.getByRole('switch', { name: '开机启动', exact: true })).toHaveAttribute('aria-checked', 'false');
  expect(await calls(page, 'set_desktop_preferences')).toHaveLength(0);
  await mkdir(resolve('native-test-results'), { recursive: true });
  await page.screenshot({ path: resolve('native-test-results/fastlingo-desktop-settings.png'), fullPage: true });

  await panel.getByLabel('关闭主窗口时', { exact: true }).selectOption('tray');
  await expect(panel.getByRole('status')).toHaveText('设置已更新');
  expect((await calls(page, 'set_desktop_preferences'))[0].args).toEqual({ closeAction: 'tray', launchAtLogin: false, updateLaunchAtLogin: false });
  await page.evaluate(() => { (window as unknown as { desktopTest: DesktopFixture }).desktopTest.holdNextSave = true; });
  await panel.getByRole('switch', { name: '开机启动', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'set_desktop_preferences')).length).toBe(2);
  await expect(panel.getByRole('switch', { name: '开机启动', exact: true })).toBeDisabled();
  await expect(panel.getByRole('switch', { name: '开机启动', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(panel.getByLabel('关闭主窗口时', { exact: true })).toBeDisabled();
  await page.evaluate(() => (window as unknown as { desktopTest: DesktopFixture }).desktopTest.releaseSave());
  await expect(panel.getByRole('switch', { name: '开机启动', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('status')).toHaveText('设置已更新');
  expect((await calls(page, 'set_desktop_preferences'))[1].args).toEqual({ closeAction: 'tray', launchAtLogin: true, updateLaunchAtLogin: true });

  await page.reload();
  panel = await openSettings(page);
  await expect(panel.getByLabel('关闭主窗口时', { exact: true })).toHaveValue('tray');
  await expect(panel.getByRole('switch', { name: '开机启动', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(await calls(page, 'set_desktop_preferences')).toHaveLength(0);
});

test('changing only the close action preserves a login-item change made outside the app', async ({ page }) => {
  await installDesktop(page);
  const panel = await openSettings(page);
  await expect(panel.getByRole('switch', { name: '开机启动', exact: true })).toHaveAttribute('aria-checked', 'false');
  await page.evaluate(() => (window as unknown as { desktopTest: DesktopFixture }).desktopTest.changeSystemLaunch(true));
  await panel.getByLabel('关闭主窗口时', { exact: true }).selectOption('tray');
  await expect(panel.getByRole('status')).toHaveText('设置已更新');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByLabel('关闭主窗口时', { exact: true })).toHaveValue('tray');
  await expect(panel.getByRole('switch', { name: '开机启动', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect((await calls(page, 'set_desktop_preferences'))[0].args).toEqual({ closeAction: 'tray', launchAtLogin: false, updateLaunchAtLogin: false });
});

test('a rejected setting shows the error, rereads actual state and permits a successful retry', async ({ page }) => {
  await installDesktop(page);
  const panel = await openSettings(page);
  const initialReads = (await calls(page, 'get_desktop_preferences')).length;
  await page.evaluate(() => { (window as unknown as { desktopTest: DesktopFixture }).desktopTest.failNextSave = true; });
  await panel.getByRole('switch', { name: '开机启动', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('系统拒绝开机启动设置');
  await expect(panel.getByRole('switch', { name: '开机启动', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(panel.getByRole('switch', { name: '开机启动', exact: true })).toBeEnabled();
  await expect(panel.getByRole('status')).toHaveCount(0);
  expect((await calls(page, 'get_desktop_preferences')).length).toBeGreaterThan(initialReads);
  await panel.getByRole('switch', { name: '开机启动', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('设置已更新');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByRole('switch', { name: '开机启动', exact: true })).toHaveAttribute('aria-checked', 'true');
});

test('a partial native failure shows the reread system value without claiming the save succeeded', async ({ page }) => {
  await installDesktop(page);
  const panel = await openSettings(page);
  await page.evaluate(() => {
    const fixture = (window as unknown as { desktopTest: DesktopFixture }).desktopTest;
    fixture.failNextSave = true; fixture.applyBeforeFailure = true;
  });
  await panel.getByRole('switch', { name: '开机启动', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('系统拒绝开机启动设置');
  await expect(panel.getByRole('switch', { name: '开机启动', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('status')).toHaveCount(0);
  expect(await calls(page, 'set_desktop_preferences')).toHaveLength(1);
});

test('unavailable tray and autostart capabilities cannot be selected or silently enabled', async ({ page }) => {
  await installDesktop(page, { preferences: { trayAvailable: false, autostartAvailable: false, autostartError: '当前安装位置不支持开机启动' } });
  const panel = await openSettings(page);
  await expect(panel.getByLabel('关闭主窗口时', { exact: true })).toHaveValue('quit');
  await expect(panel.locator('option[value="tray"]')).toBeDisabled();
  await expect(panel.getByRole('switch', { name: '开机启动', exact: true })).toBeDisabled();
  await expect(panel).toContainText('当前安装位置不支持开机启动');
  await expect(panel).toContainText('系统托盘暂不可用');
  expect(await calls(page, 'set_desktop_preferences')).toHaveLength(0);
});

test('a settings read error disables mutations and can be retried without changing defaults', async ({ page }) => {
  await installDesktop(page, { failReads: true });
  const panel = await openSettings(page);
  await expect(panel.getByRole('alert')).toContainText('无法读取系统登录项');
  await expect(panel.getByLabel('关闭主窗口时', { exact: true })).toBeDisabled();
  await expect(panel.getByRole('switch', { name: '开机启动', exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as unknown as { desktopTest: DesktopFixture }).desktopTest.failReads = false; });
  await panel.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByLabel('关闭主窗口时', { exact: true })).toBeEnabled();
  await expect(panel.getByRole('switch', { name: '开机启动', exact: true })).toHaveAttribute('aria-checked', 'false');
  expect(await calls(page, 'set_desktop_preferences')).toHaveLength(0);
});
