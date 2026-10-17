import { test, expect, type Page } from '@playwright/test';
import type { ChatGPTStatus } from '../src/lib/codex';

interface NativeCall { command: string; args: Record<string, unknown>; }
interface ChatGPTFixture {
  calls: NativeCall[];
  status: ChatGPTStatus;
  signInStatus: ChatGPTStatus;
  holdCheck: boolean;
  releaseCheck: () => void;
  checkError: string;
  holdSignIn: boolean;
  finishSignIn: () => void;
  signInError: string;
  signInCancelled: boolean;
  commitSignInBeforeReturn: boolean;
  selectError: string;
  disconnectMessage: string;
  holdTranslation: boolean;
  finishTranslation: () => void;
}

async function installFixture(page: Page, options: { surface?: 'desktop' | 'browser' | 'mobile'; seeded?: boolean } = {}) {
  // Every native operation is mocked. No user identity, browser sign-in or GPT request is accessed.
  await page.route('https://**', route => route.abort('blockedbyclient'));
  await page.addInitScript(({ surface = 'desktop', seeded }) => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: surface === 'mobile' ? 'iPhone' : 'Win32' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: surface === 'mobile' ? 5 : 0 });
    if (surface === 'mobile') Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
    if (seeded) {
      localStorage.setItem('fastdict.v1.providers', JSON.stringify([{ id: 'codex-test', name: 'My ChatGPT', kind: 'codex', model: 'gpt-6-luna', hasKey: true, baseUrl: 'https://ignored.example' }]));
      localStorage.setItem('fastdict.v1.preferences', JSON.stringify({ activeProviderId: 'codex-test', autoTranslate: false }));
    }
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, Set<number>>();
    let nextId = 1;
    const connected: ChatGPTStatus = { available: true, connected: true, planEnabled: true, accountLabel: 'Test account', modelAvailable: true, models: [{ slug: 'gpt-6-luna', displayName: 'GPT-6 Luna' }], profiles: [{ id: 'registration-a', label: 'Test account · A', active: true, connected: true, planEnabled: true }, { id: 'registration-b', label: 'Test account · B', active: false, connected: true, planEnabled: true }] };
    const state: ChatGPTFixture = {
      calls: [], status: seeded ? { ...connected } : { available: true, connected: false, planEnabled: false, modelAvailable: false }, signInStatus: connected,
      holdCheck: false, releaseCheck: () => undefined, checkError: '', holdSignIn: false, finishSignIn: () => undefined, signInError: '', signInCancelled:false, commitSignInBeforeReturn:false, selectError: '', disconnectMessage: '已断开 ChatGPT 连接。', holdTranslation: false, finishTranslation: () => undefined,
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
          if (command === 'get_chatgpt_status') {
            const snapshot = { ...state.status };
            if (state.holdCheck) await new Promise<void>(resolve => { state.releaseCheck = resolve; });
            if (state.checkError) throw new Error(state.checkError);
            return snapshot;
          }
          if (command === 'sign_in_chatgpt') {
            const snapshot = { ...state.signInStatus };
            state.signInCancelled = false;
            if (state.commitSignInBeforeReturn) state.status = snapshot;
            if (state.holdSignIn) await new Promise<void>(resolve => { state.finishSignIn = resolve; });
            if (state.signInCancelled) throw new Error('已取消 ChatGPT 登录');
            if (state.signInError) throw new Error(state.signInError);
            state.status = snapshot;
            return { ...snapshot, modelAvailable:false, models:[], message:snapshot.connected && snapshot.planEnabled ? '已连接 ChatGPT 并授权使用订阅，请刷新以获取可用模型。' : snapshot.message };
          }
          if (command === 'cancel_chatgpt_sign_in') {
            if (!state.commitSignInBeforeReturn) state.signInCancelled = true;
            return { ...state.status,modelAvailable:false,models:[],message:state.status.connected && state.status.planEnabled ? '已连接 ChatGPT 并授权使用订阅，请刷新以获取可用模型。' : state.status.message };
          }
          if (command === 'open_chatgpt_usage') return;
          if (command === 'forget_chatgpt_profile') {
            const removed = state.status.profiles?.find(profile => profile.id === args.profileId);
            state.status = { ...state.status, ...(removed?.active ? { connected:false,planEnabled:false,modelAvailable:false,accountLabel:undefined,models:[] } : {}),
              profiles:state.status.profiles?.filter(profile => profile.id !== args.profileId), message:'已忘记此 ChatGPT 连接。' };
            return state.status;
          }
          if (command === 'select_chatgpt_profile') {
            if (state.selectError) throw new Error(state.selectError);
            state.status = { ...state.status, accountLabel: args.profileId === 'registration-a' ? 'Test account · A' : 'Test account · B', profiles: state.status.profiles?.map(profile => ({ ...profile, active: profile.id === args.profileId })) };
            return state.status;
          }
          if (command === 'disconnect_chatgpt') { state.status = { available: true, connected: false, planEnabled: false, modelAvailable: false, message: state.disconnectMessage }; return state.status; }
          if (command === 'translate_with_chatgpt') {
            if (!state.status.connected || !state.status.planEnabled) throw new Error('请先登录 ChatGPT 并授权使用订阅。');
            if (!state.status.modelAvailable) throw new Error('所选 ChatGPT 模型当前不可用。');
            const channel = args.onEvent as { id: number };
            callbacks.get(channel.id)?.({ index: 0, message: { type: 'delta', text: '你好' } });
            if (state.holdTranslation) await new Promise<void>(resolve => { state.finishTranslation = resolve; });
            callbacks.get(channel.id)?.({ index: 1, message: { type: 'delta', text: '，世界。' } });
            return '你好，世界。';
          }
          if (command === 'cancel_chatgpt_translation') return;
          if (command === 'get_desktop_preferences') return { closeAction: 'quit', launchAtLogin: false, trayAvailable: true, autostartAvailable: true };
          if (command === 'get_shortcut_status') return { captureShortcut: 'Ctrl+Shift+S', clipboardShortcut: 'Ctrl+Shift+D', error: null };
          if (['frontend_ready', 'report_boot_error', 'quit_app', 'hide_window', 'expand_window'].includes(command)) return;
          throw new Error(`Unexpected ChatGPT fixture IPC: ${command}`);
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
    const items = (window as unknown as { codexTest: ChatGPTFixture }).codexTest.calls;
    return command ? items.filter(item => item.command === command) : items;
  }, command);
}

async function chooseChatGPT(page: Page) {
  await page.getByRole('region', { name: '添加翻译服务引导' }).getByRole('button', { name: '添加翻译服务', exact: true }).click();
  await page.getByRole('dialog', { name: '添加翻译服务', exact: true }).getByRole('button', { name: /ChatGPT 订阅/ }).click();
  const editor = page.getByRole('dialog', { name: 'ChatGPT 订阅配置' });
  await expect(editor).toBeVisible();
  return editor;
}

function expectNoCredentialOrHttpCalls(items: NativeCall[]) {
  expect(items.filter(item => /^(get|save|delete)_api_key$/.test(item.command) || item.command.startsWith('plugin:http|') || /codex/.test(item.command))).toEqual([]);
  expect(JSON.stringify(items)).not.toMatch(/accessToken|refreshToken|idToken|apiKey|codeVerifier|authorizationCode/);
}

test('official ChatGPT sign-in adds a provider, confirms plan use, streams translation and manages the account', async ({ page }) => {
  await installFixture(page);
  expect(await page.evaluate(() => localStorage.getItem('fastdict.v1.providers'))).toBeNull();
  expect(await calls(page, 'get_chatgpt_status')).toEqual([]);
  const editor = await chooseChatGPT(page);
  await expect(editor.getByLabel('模型名称')).toHaveValue('gpt-6-luna');
  await expect(editor.getByLabel('API 地址')).toHaveCount(0);
  await expect(editor.getByLabel(/API Key/)).toHaveCount(0);
  await editor.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  const notice = editor.getByRole('alertdialog', { name: '正在使用 ChatGPT 套餐' });
  await expect(notice).toBeVisible();
  await expect(editor.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
  await notice.getByRole('button', { name: '知道了', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('所选模型可用');
  expect((await calls(page, 'sign_in_chatgpt'))[0].args).toEqual({ model: 'gpt-6-luna', newAccount: false });
  expect(await calls(page, 'translate_with_chatgpt')).toEqual([]);
  await expect(editor.locator('datalist option')).toHaveAttribute('value', 'gpt-6-luna');
  await editor.getByRole('button', { name: '管理用量', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'open_chatgpt_usage')).length).toBe(1);
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(editor).toHaveCount(0);
  const metadata = await page.evaluate(() => JSON.parse(localStorage.getItem('fastdict.v1.configuration')!).providers);
  expect(metadata).toEqual([{ id: expect.any(String), name: 'ChatGPT 订阅', kind: 'codex', baseUrl: '', model: 'gpt-6-luna', hasKey: false }]);
  expect(await page.evaluate(() => localStorage.getItem('fastdict.v1.chatgptPlanNotice'))).toBe('acknowledged');
  await page.getByRole('textbox', { name: '待翻译文本' }).fill('Hello world');
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(page.locator('.translation-output')).toHaveText('你好，世界。');
  const request = (await calls(page, 'translate_with_chatgpt'))[0].args;
  expect(request).toMatchObject({ model: 'gpt-6-luna', text: 'Hello world', sourceLang: 'auto', targetLang: 'zh-CN', requestId: expect.any(String) });
  expect(Object.keys(request).sort()).toEqual(['instructions', 'model', 'onEvent', 'requestId', 'sourceLang', 'targetLang', 'text']);
  expect(request.instructions).toContain('professional translator');
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  await page.locator('.settings-provider').click();
  await editor.getByRole('button', { name: '刷新连接', exact: true }).click();
  await editor.getByRole('button', { name: '重新授权', exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(editor.getByRole('status')).toContainText('所选模型可用');
  await page.evaluate(() => { (window as unknown as { codexTest: ChatGPTFixture }).codexTest.disconnectMessage = '已在本机断开 ChatGPT 连接。远端撤销未完成，请在 ChatGPT 用量设置中移除授权。'; });
  await editor.getByRole('button', { name: '断开连接', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('远端撤销未完成');
  await expect(editor.getByRole('button', { name: '管理用量', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Continue with ChatGPT', exact: true })).toBeVisible();
  expect(await calls(page, 'disconnect_chatgpt')).toHaveLength(1);
  const persisted = await page.evaluate(() => Object.values(localStorage).join(''));
  expect(persisted).not.toContain('Test account');
  expectNoCredentialOrHttpCalls(await calls(page));
});

test('a custom settings prompt reaches the native ChatGPT translation with the selected language', async ({ page }) => {
  await installFixture(page, { seeded: true });
  await page.getByLabel('目标语言', { exact: true }).selectOption('ja');
  await page.getByRole('button', { name: /^偏好设置/ }).click();
  await page.getByRole('button', { name: '编辑翻译提示词', exact: true }).click();
  await page.getByRole('textbox', { name: '翻译提示词', exact: true }).fill('Translate into {{targetLang}}. Keep NATIVE_PROMPT_MARKER terminology.');
  await page.getByRole('button', { name: '保存提示词', exact: true }).click();
  await page.getByRole('button', { name: '即时翻译', exact: true }).click();
  await page.getByRole('textbox', { name: '待翻译文本' }).fill('Source with literal {{targetLang}}.');
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(page.locator('.translation-output')).toHaveText('你好，世界。');
  const invocation = (await calls(page, 'translate_with_chatgpt'))[0];
  expect(invocation.args.instructions).toContain('Translate into ja');
  expect(invocation.args.instructions).toContain('NATIVE_PROMPT_MARKER');
  expect(invocation.args.instructions).not.toContain('Source with literal');
  expect(invocation.args.text).toBe('Source with literal {{targetLang}}.');
});

test('saved registrations switch by ID without opening browser sign-in, and failed selection preserves the active account', async ({ page }) => {
  await installFixture(page, { seeded: true });
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  await page.locator('.settings-provider').click();
  const editor = page.getByRole('dialog', { name: 'ChatGPT 订阅配置' });
  await editor.getByRole('button', { name: '刷新连接', exact: true }).click();
  const accounts = editor.getByLabel('ChatGPT 账号', { exact: true });
  await expect(accounts).toHaveValue('registration-a');
  await accounts.selectOption('registration-b');
  await expect(accounts).toHaveValue('registration-b');
  await expect(editor.getByRole('status')).toContainText('Test account · B');
  expect((await calls(page, 'select_chatgpt_profile'))[0].args).toEqual({ profileId: 'registration-b', model: 'gpt-6-luna' });
  expect(await calls(page, 'sign_in_chatgpt')).toEqual([]);
  await page.evaluate(() => { (window as unknown as { codexTest: ChatGPTFixture }).codexTest.selectError = '无法切换所选 ChatGPT 账号，请重试。'; });
  await accounts.selectOption('registration-a');
  await expect(editor.getByRole('alert')).toContainText('无法切换');
  await expect(accounts).toHaveValue('registration-b');
  await expect(editor.getByRole('status')).toContainText('Test account · B');
  const persisted = await page.evaluate(() => Object.values(localStorage).join(''));
  expect(persisted).not.toMatch(/registration-a|registration-b|Test account/);
  expectNoCredentialOrHttpCalls(await calls(page));
});

test('identity login without plan consent and missing model remain distinct from inference-ready connection', async ({ page }) => {
  await installFixture(page);
  const editor = await chooseChatGPT(page);
  await page.evaluate(() => { (window as unknown as { codexTest: ChatGPTFixture }).codexTest.signInStatus.planEnabled = false; });
  await editor.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('尚未授权');
  await expect(editor.getByRole('alertdialog')).toHaveCount(0);
  await expect(editor.getByRole('button', { name: '重新授权', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = (window as unknown as { codexTest: ChatGPTFixture }).codexTest;
    state.status.planEnabled = true; state.status.modelAvailable = false;
  });
  await editor.getByRole('button', { name: '刷新连接', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('可用模型目录中未找到所选模型');
  expect(await calls(page, 'translate_with_chatgpt')).toEqual([]);
  expectNoCredentialOrHttpCalls(await calls(page));
});

test('refused login remains disconnected and a cancelled browser sign-in cannot update the editor later', async ({ page }) => {
  await installFixture(page);
  const editor = await chooseChatGPT(page);
  await page.evaluate(() => { (window as unknown as { codexTest: ChatGPTFixture }).codexTest.signInError = 'ChatGPT 登录已取消或未获授权。'; });
  await editor.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('未获授权');
  await expect(editor.getByRole('status')).toHaveCount(0);
  await page.evaluate(() => {
    const state = (window as unknown as { codexTest: ChatGPTFixture }).codexTest;
    state.signInError = ''; state.holdSignIn = true;
  });
  await editor.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('系统浏览器');
  await expect(editor.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: '取消登录', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'cancel_chatgpt_sign_in')).length).toBe(1);
  await page.evaluate(() => { (window as unknown as { codexTest: ChatGPTFixture }).codexTest.finishSignIn(); });
  await expect(editor.getByRole('button', { name: 'Continue with ChatGPT', exact:true })).toBeVisible();
  await expect(editor.getByRole('status')).toContainText('尚未连接');
  await expect(editor.getByRole('alertdialog')).toHaveCount(0);
  expect(await calls(page, 'translate_with_chatgpt')).toEqual([]);
  expectNoCredentialOrHttpCalls(await calls(page));
});

test('model changes and editor closure discard old connection and account-switch responses', async ({ page }) => {
  await installFixture(page, { seeded: true });
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  await page.locator('.settings-provider').click();
  const editor = page.getByRole('dialog', { name: 'ChatGPT 订阅配置' });
  await page.evaluate(() => { (window as unknown as { codexTest: ChatGPTFixture }).codexTest.holdCheck = true; });
  await editor.getByRole('button', { name: '刷新连接', exact: true }).click();
  await expect(editor.getByRole('region', { name: 'ChatGPT 连接' })).toHaveAttribute('aria-busy', 'true');
  await expect.poll(async () => (await calls(page, 'get_chatgpt_status')).length).toBe(1);
  await editor.getByLabel('模型名称').fill('another-model');
  await page.evaluate(() => { (window as unknown as { codexTest: ChatGPTFixture }).codexTest.releaseCheck(); });
  await expect(editor.getByRole('status')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { codexTest: ChatGPTFixture }).codexTest.holdCheck = false; });
  await editor.getByRole('button', { name: '刷新连接', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('所选模型可用');
  expect((await calls(page, 'get_chatgpt_status')).at(-1)?.args).toEqual({ model: 'another-model' });
  await page.evaluate(() => { (window as unknown as { codexTest: ChatGPTFixture }).codexTest.holdSignIn = true; });
  await editor.getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(editor.getByRole('status')).toContainText('系统浏览器');
  await expect.poll(async () => (await calls(page, 'sign_in_chatgpt')).at(-1)?.args).toEqual({ model: 'another-model', newAccount: true });
  await editor.getByRole('button', { name: '关闭配置', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'cancel_chatgpt_sign_in')).length).toBe(1);
  await page.evaluate(() => { (window as unknown as { codexTest: ChatGPTFixture }).codexTest.finishSignIn(); });
  await expect(editor).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('fastdict.v1.chatgptPlanNotice'))).toBeNull();
  expectNoCredentialOrHttpCalls(await calls(page));
});

test('stopping a ChatGPT stream cancels the matching native request and discards its late result', async ({ page }) => {
  await installFixture(page, { seeded: true });
  await page.evaluate(() => { (window as unknown as { codexTest: ChatGPTFixture }).codexTest.holdTranslation = true; });
  await page.getByRole('textbox', { name: '待翻译文本' }).fill('Hello');
  await page.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(page.locator('.translation-output')).toHaveText('你好');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'cancel_chatgpt_translation')).length).toBe(1);
  expect((await calls(page, 'cancel_chatgpt_translation'))[0].args.requestId).toBe((await calls(page, 'translate_with_chatgpt'))[0].args.requestId);
  await page.evaluate(() => { (window as unknown as { codexTest: ChatGPTFixture }).codexTest.finishTranslation(); });
  await expect(page.locator('.translation-output')).toHaveText('你好');
  expect(await page.evaluate(() => localStorage.getItem('fastdict.v1.history'))).toBeNull();
  expectNoCredentialOrHttpCalls(await calls(page));
});

for (const close of [false,true]) {
  test(`late sign-in ${close ? 'editor closure' : 'cancellation'} reconciles committed account B rather than restoring account A`, async ({ page }) => {
    await installFixture(page,{ seeded:true });
    await page.getByRole('button',{ name:'偏好设置',exact:true }).click();
    await page.locator('.settings-provider').click();
    const editor = page.getByRole('dialog',{ name:'ChatGPT 订阅配置' });
    await editor.getByRole('button',{ name:'刷新连接',exact:true }).click();
    await expect(editor.getByLabel('ChatGPT 账号',{ exact:true })).toHaveValue('registration-a');
    await page.evaluate(() => {
      const state = (window as unknown as { codexTest:ChatGPTFixture }).codexTest;
      state.holdSignIn = true; state.commitSignInBeforeReturn = true;
      state.signInStatus = { ...state.signInStatus,accountLabel:'Committed B',profiles:state.signInStatus.profiles?.map(profile => ({ ...profile,active:profile.id==='registration-b' })) };
    });
    await editor.getByRole('button',{ name:'添加账号',exact:true }).click();
    await expect.poll(async () => (await calls(page,'sign_in_chatgpt')).length).toBe(1);
    await editor.getByRole('button',{ name:close ? '关闭配置' : '取消登录',exact:true }).click();
    await expect.poll(async () => (await calls(page,'cancel_chatgpt_sign_in')).length).toBe(1);
    await expect(editor.getByRole('button',{ name:'正在确认连接',exact:true })).toBeDisabled();
    await page.evaluate(() => { (window as unknown as { codexTest:ChatGPTFixture }).codexTest.finishSignIn(); });
    if (close) {
      await expect(editor).toHaveCount(0);
      await page.locator('.settings-provider').click();
      await editor.getByRole('button',{ name:'刷新连接',exact:true }).click();
    }
    await expect(editor.getByRole('status')).toContainText(close ? 'Committed B' : '已连接 ChatGPT');
    await expect(editor.getByLabel('ChatGPT 账号',{ exact:true })).toHaveValue('registration-b');
    await expect(editor.getByRole('alertdialog')).toHaveCount(0);
    expect((await page.evaluate(() => (window as unknown as { codexTest:ChatGPTFixture }).codexTest.status)).accountLabel).toBe('Committed B');
    expect(await calls(page,'translate_with_chatgpt')).toEqual([]);
  });
}

test('committed sign-in is connected while model lookup is pending, and closing the editor leaves that connection intact', async ({ page }) => {
  await installFixture(page);
  const editor = await chooseChatGPT(page);
  await page.evaluate(() => { (window as unknown as { codexTest:ChatGPTFixture }).codexTest.holdCheck = true; });
  await editor.getByRole('button',{ name:'Continue with ChatGPT',exact:true }).click();
  await expect.poll(async () => (await calls(page,'get_chatgpt_status')).length).toBe(1);
  await expect(editor.getByRole('status')).toContainText('已连接 ChatGPT');
  await expect(editor.getByRole('button',{ name:'取消登录',exact:true })).toHaveCount(0);
  await expect(editor.getByRole('button',{ name:'正在刷新',exact:true })).toBeDisabled();
  await editor.getByRole('button',{ name:'关闭配置',exact:true }).click();
  await expect(editor).toHaveCount(0);
  expect(await calls(page,'cancel_chatgpt_sign_in')).toEqual([]);
  await page.evaluate(() => { (window as unknown as { codexTest:ChatGPTFixture }).codexTest.releaseCheck(); });
  await expect(editor).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { codexTest:ChatGPTFixture }).codexTest.status.connected)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('fastdict.v1.chatgptPlanNotice'))).toBeNull();
});

test('forgetting a registration requires confirmation and preserves the other saved accounts', async ({ page }) => {
  await installFixture(page,{ seeded:true });
  await page.getByRole('button',{ name:'偏好设置',exact:true }).click();
  await page.locator('.settings-provider').click();
  const editor = page.getByRole('dialog',{ name:'ChatGPT 订阅配置' });
  await editor.getByRole('button',{ name:'刷新连接',exact:true }).click();
  await expect(editor.getByLabel('ChatGPT 账号',{ exact:true })).toHaveValue('registration-a');
  await editor.getByRole('button',{ name:'忘记此连接',exact:true }).click();
  expect(await calls(page,'forget_chatgpt_profile')).toEqual([]);
  await expect(editor).toContainText('其他账号会保留');
  await editor.getByRole('button',{ name:'确认忘记此连接',exact:true }).click();
  await expect(editor.getByRole('status')).toContainText('已忘记');
  const accounts = editor.getByLabel('ChatGPT 账号',{ exact:true });
  await expect(accounts.locator('option[value="registration-a"]')).toHaveCount(0);
  await expect(accounts.locator('option[value="registration-b"]')).toHaveCount(1);
  // A removed active registration leaves no implicit selection. The remaining
  // registration must be explicitly selected before its own removal is enabled.
  await expect(editor.getByRole('button',{ name:'忘记此连接',exact:true })).toBeDisabled();
  expect((await calls(page,'forget_chatgpt_profile'))[0].args).toEqual({ profileId:'registration-a',model:'gpt-6-luna' });
  expect(await calls(page,'sign_in_chatgpt')).toEqual([]);
  expect(await calls(page,'translate_with_chatgpt')).toEqual([]);
  await accounts.selectOption('registration-b');
  await expect(accounts).toHaveValue('registration-b');
  await expect(editor.getByRole('button',{ name:'忘记此连接',exact:true })).toBeEnabled();
  expect(await calls(page,'forget_chatgpt_profile')).toHaveLength(1);
  await editor.getByRole('button',{ name:'忘记此连接',exact:true }).click();
  expect(await calls(page,'forget_chatgpt_profile')).toHaveLength(1);
  await editor.getByRole('button',{ name:'确认忘记此连接',exact:true }).click();
  await expect(accounts).toHaveCount(0);
  expect((await calls(page,'forget_chatgpt_profile'))[1].args).toEqual({ profileId:'registration-b',model:'gpt-6-luna' });
});

for (const surface of ['browser', 'mobile'] as const) {
  test(`${surface} hides ChatGPT additions and blocks an existing desktop-only provider`, async ({ page }) => {
    if (surface === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
    await installFixture(page, { surface, seeded: true });
    await page.getByRole('textbox', { name: '待翻译文本' }).fill('Hello');
    await page.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('ChatGPT 订阅翻译目前仅支持 Windows 和 macOS 桌面版');
    await page.getByRole('button', { name: '偏好设置', exact: true }).click();
    await page.locator('.settings-provider').click();
    const editor = page.getByRole('dialog', { name: 'ChatGPT 订阅配置' });
    await expect(editor).toContainText('ChatGPT 订阅翻译仅支持桌面应用');
    await expect(editor.getByRole('button', { name: '刷新连接', exact: true })).toBeDisabled();
    await expect(editor.getByRole('button', { name: 'Continue with ChatGPT', exact: true })).toBeDisabled();
    await expect(editor.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
    await expect(editor.getByLabel(/API Key/)).toHaveCount(0);
    await editor.getByRole('button', { name: '关闭配置', exact: true }).click();
    await page.getByRole('button', { name: '添加服务', exact: true }).click();
    const presets = page.getByRole('dialog', { name: '添加翻译服务', exact: true });
    await expect(presets.getByRole('button', { name: /ChatGPT 订阅/ })).toHaveCount(0);
    await expect(presets.getByRole('button', { name: 'O OpenAI OpenAI 兼容接口', exact: true })).toBeVisible();
    expect(await calls(page, 'get_chatgpt_status')).toEqual([]);
    expect(await calls(page, 'translate_with_chatgpt')).toEqual([]);
    expectNoCredentialOrHttpCalls(await calls(page));
  });
}
