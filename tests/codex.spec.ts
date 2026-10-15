import { test, expect, type Page } from '@playwright/test';
import type { CodexStatus } from '../src/lib/codex';

interface NativeCall { command: string; args: Record<string, unknown>; }
interface CodexFixture {
  calls: NativeCall[];
  status: CodexStatus;
  holdCheck: boolean;
  releaseCheck: () => void;
  checkError: string;
  holdTranslation: boolean;
  finishTranslation: () => void;
}

async function installFixture(page: Page, options: { surface?: 'desktop' | 'browser' | 'mobile'; seeded?: boolean } = {}) {
  // Every native operation is mocked. No user profile, Codex process or GPT request is accessed.
  await page.route('https://**', route => route.abort('blockedbyclient'));
  await page.addInitScript(({ surface = 'desktop', seeded }) => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: surface === 'mobile' ? 'iPhone' : 'Win32' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: surface === 'mobile' ? 5 : 0 });
    if (surface === 'mobile') Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
    if (seeded) {
      localStorage.setItem('fastdict.v1.providers', JSON.stringify([{ id: 'codex-test', name: 'My Codex', kind: 'codex', model: 'gpt-6-luna', hasKey: true, baseUrl: 'https://ignored.example' }]));
      localStorage.setItem('fastdict.v1.preferences', JSON.stringify({ activeProviderId: 'codex-test', autoTranslate: false }));
    }
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, Set<number>>();
    let nextId = 1;
    const state: CodexFixture = {
      calls: [], status: { available: true, authenticated: true, authMode: 'chatgpt', version: 'test-only', modelAvailable: true },
      holdCheck: false, releaseCheck: () => undefined, checkError: '', holdTranslation: false, finishTranslation: () => undefined,
    };
    Object.assign(window, { codexTest: state });
    if (surface === 'browser') return;
    Object.assign(window, {
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
          if (command === 'get_codex_status') {
            const snapshot = { ...state.status };
            if (state.holdCheck) await new Promise<void>(resolve => { state.releaseCheck = resolve; });
            if (state.checkError) throw new Error(state.checkError);
            return snapshot;
          }
          if (command === 'translate_with_codex') {
            const channel = args.onEvent as { id: number };
            callbacks.get(channel.id)?.({ index: 0, message: { type: 'delta', text: '你好' } });
            if (state.holdTranslation) await new Promise<void>(resolve => { state.finishTranslation = resolve; });
            callbacks.get(channel.id)?.({ index: 1, message: { type: 'delta', text: '，世界。' } });
            return '你好，世界。';
          }
          if (command === 'cancel_codex_translation') return;
          if (command === 'get_desktop_preferences') return { closeAction: 'quit', launchAtLogin: false, trayAvailable: true, autostartAvailable: true };
          if (command === 'get_shortcut_status') return { captureShortcut: 'Ctrl+Shift+S', clipboardShortcut: 'Ctrl+Shift+D', error: null };
          if (['frontend_ready', 'report_boot_error', 'quit_app', 'hide_window', 'expand_window'].includes(command)) return;
          throw new Error(`Unexpected Codex fixture IPC: ${command}`);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string, id: number) => { listeners.get(event)?.delete(id); callbacks.delete(id); } },
    });
  }, options);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).toBeVisible();
}

async function calls(page: Page, command?: string): Promise<NativeCall[]> {
  return page.evaluate(command => {
    const items = (window as unknown as { codexTest: CodexFixture }).codexTest.calls;
    return command ? items.filter(item => item.command === command) : items;
  }, command);
}

async function chooseCodex(page: Page) {
  await page.getByRole('region', { name: '添加翻译服务引导' }).getByRole('button', { name: '添加翻译服务', exact: true }).click();
  await page.getByRole('dialog', { name: '添加翻译服务', exact: true }).getByRole('button', { name: /本机 Codex（GPT 订阅）/ }).click();
  const editor = page.getByRole('dialog', { name: '本机 Codex 配置' });
  await expect(editor).toBeVisible();
  return editor;
}

function expectNoCredentialOrHttpCalls(items: NativeCall[]) {
  expect(items.filter(item => /^(get|save|delete)_api_key$/.test(item.command) || item.command.startsWith('plugin:http|'))).toEqual([]);
}

test('desktop manually adds and checks Codex, translates, reloads and removes without API credentials', async ({ page }) => {
  await installFixture(page);
  expect(await page.evaluate(() => localStorage.getItem('fastdict.v1.providers'))).toBeNull();
  expect(await calls(page, 'get_codex_status')).toEqual([]);
  const editor = await chooseCodex(page);
  await expect(editor.getByLabel('模型名称')).toHaveValue('gpt-6-luna');
  await expect(editor.getByLabel('API 地址')).toHaveCount(0);
  await expect(editor.getByLabel(/API Key/)).toHaveCount(0);
  await editor.getByRole('button', { name: '检测连接', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('已通过 ChatGPT 登录，已发现所选模型');
  await expect(editor.getByRole('status')).toContainText('实际模型权限以翻译结果为准');
  expect((await calls(page, 'get_codex_status'))[0].args).toEqual({ model: 'gpt-6-luna' });
  expect(await calls(page, 'translate_with_codex')).toEqual([]);
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.availability')).toHaveText('Codex 已检测');
  const metadata = await page.evaluate(() => JSON.parse(localStorage.getItem('fastdict.v1.providers')!));
  expect(metadata).toEqual([{ id: expect.any(String), name: '本机 Codex（GPT 订阅）', kind: 'codex', baseUrl: '', model: 'gpt-6-luna', hasKey: false }]);
  await page.getByRole('textbox', { name: '待翻译文本' }).fill('Hello world');
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(page.locator('.translation-output')).toHaveText('你好，世界。');
  const request = (await calls(page, 'translate_with_codex'))[0].args;
  expect(request).toMatchObject({ model: 'gpt-6-luna', text: 'Hello world', sourceLang: 'auto', targetLang: 'zh-CN', requestId: expect.any(String) });
  expect(Object.keys(request).sort()).toEqual(['model', 'onEvent', 'requestId', 'sourceLang', 'targetLang', 'text']);
  expectNoCredentialOrHttpCalls(await calls(page));
  await page.reload();
  await expect(page.locator('.availability')).toHaveText('Codex 待检测');
  expect(await calls(page, 'get_codex_status')).toEqual([]);
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  await expect(page.locator('.settings-provider')).toContainText('本机订阅');
  await page.locator('.settings-provider').click();
  await page.getByRole('button', { name: '移除服务', exact: true }).click();
  await page.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(page.locator('.settings-provider')).toHaveCount(0);
  expectNoCredentialOrHttpCalls(await calls(page));
});

test('Codex checks distinguish API-key login, missing model, failures and stale model responses', async ({ page }) => {
  await installFixture(page);
  const editor = await chooseCodex(page);
  await page.evaluate(() => { (window as unknown as { codexTest: CodexFixture }).codexTest.status.authMode = 'apikey'; });
  await editor.getByRole('button', { name: '检测连接', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('当前 Codex 使用 API Key 登录');
  await page.evaluate(() => {
    const state = (window as unknown as { codexTest: CodexFixture }).codexTest;
    state.status.authMode = 'chatgpt'; state.status.modelAvailable = false;
  });
  await editor.getByRole('button', { name: '检测连接', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('模型目录中未找到所选模型');
  await page.evaluate(() => { (window as unknown as { codexTest: CodexFixture }).codexTest.checkError = 'Codex 检测超时，请重试'; });
  await editor.getByRole('button', { name: '检测连接', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('检测超时');
  await expect(editor.getByRole('status')).toHaveCount(0);
  await page.evaluate(() => {
    const state = (window as unknown as { codexTest: CodexFixture }).codexTest;
    state.checkError = ''; state.status.modelAvailable = true; state.holdCheck = true;
  });
  await editor.getByRole('button', { name: '检测连接', exact: true }).click();
  await expect(editor.getByRole('region', { name: 'Codex 连接检测' })).toHaveAttribute('aria-busy', 'true');
  await editor.getByLabel('模型名称').fill('another-model');
  await page.evaluate(() => { (window as unknown as { codexTest: CodexFixture }).codexTest.releaseCheck(); });
  await expect(editor.getByRole('status')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { codexTest: CodexFixture }).codexTest.holdCheck = false; });
  await editor.getByRole('button', { name: '检测连接', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('已发现所选模型');
  expect((await calls(page, 'get_codex_status')).at(-1)?.args).toEqual({ model: 'another-model' });
  await editor.getByLabel('模型名称').fill('gpt-6-luna');
  await expect(editor.getByRole('status')).toHaveCount(0);
  expect(await calls(page, 'translate_with_codex')).toEqual([]);
  expectNoCredentialOrHttpCalls(await calls(page));
});

test('stopping a Codex stream cancels the matching native request and discards its late result', async ({ page }) => {
  await installFixture(page, { seeded: true });
  await page.evaluate(() => { (window as unknown as { codexTest: CodexFixture }).codexTest.holdTranslation = true; });
  await page.getByRole('textbox', { name: '待翻译文本' }).fill('Hello');
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(page.locator('.translation-output')).toHaveText('你好');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'cancel_codex_translation')).length).toBe(1);
  expect((await calls(page, 'cancel_codex_translation'))[0].args.requestId).toBe((await calls(page, 'translate_with_codex'))[0].args.requestId);
  await page.evaluate(() => { (window as unknown as { codexTest: CodexFixture }).codexTest.finishTranslation(); });
  await expect(page.locator('.translation-output')).toHaveText('你好');
  expect(await page.evaluate(() => localStorage.getItem('fastdict.v1.history'))).toBeNull();
  expectNoCredentialOrHttpCalls(await calls(page));
});

for (const surface of ['browser', 'mobile'] as const) {
  test(`${surface} hides Codex additions and clearly blocks an existing desktop-only provider`, async ({ page }) => {
    if (surface === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
    await installFixture(page, { surface, seeded: true });
    await expect(page.locator('.availability')).toHaveText('Codex 仅限桌面');
    await page.getByRole('textbox', { name: '待翻译文本' }).fill('Hello');
    await page.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('本机 Codex 仅支持桌面应用');
    await page.getByRole('button', { name: '偏好设置', exact: true }).click();
    await page.locator('.settings-provider').click();
    const editor = page.getByRole('dialog', { name: '本机 Codex 配置' });
    await expect(editor).toContainText('本机 Codex 仅支持桌面应用');
    await expect(editor.getByRole('button', { name: '检测连接', exact: true })).toBeDisabled();
    await expect(editor.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
    await expect(editor.getByLabel(/API Key/)).toHaveCount(0);
    await editor.getByRole('button', { name: '关闭配置', exact: true }).click();
    await page.getByRole('button', { name: '添加服务', exact: true }).click();
    const presets = page.getByRole('dialog', { name: '添加翻译服务', exact: true });
    await expect(presets.getByRole('button', { name: /本机 Codex/ })).toHaveCount(0);
    await expect(presets.getByRole('button', { name: 'O OpenAI OpenAI 兼容接口', exact: true })).toBeVisible();
    expect(await calls(page, 'get_codex_status')).toEqual([]);
    expect(await calls(page, 'translate_with_codex')).toEqual([]);
    expectNoCredentialOrHttpCalls(await calls(page));
  });
}
