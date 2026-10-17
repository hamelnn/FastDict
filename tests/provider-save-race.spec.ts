import { expect, test } from '@playwright/test';

interface SaveRaceFixture {
  calls: Array<{ command: string; args: Record<string, unknown> }>;
  vaultPending: boolean;
  readPending: boolean;
  bodyDelivered: boolean;
  releaseVault: () => void;
  releaseOldBody: () => void;
  emitClipboard: (text: string) => void;
}

test('committing a provider stops an old-service request started while the vault write was pending', async ({ page }) => {
  // The OS vault and native HTTP transport are controlled fixtures. Nothing
  // leaves the browser, and only synthetic credentials and source text are used.
  await page.route('https://**', route => route.abort('blockedbyclient'));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    const provider = { id: 'save-race-provider', name: 'Original service', kind: 'openai', model: 'fixture', baseUrl: 'https://old.example/v1', hasKey: true };
    localStorage.setItem('fastdict.v1.providers', JSON.stringify([provider]));
    localStorage.setItem('fastdict.v1.preferences', JSON.stringify({ autoTranslate: true, activeProviderId: provider.id, ocrLang: 'eng' }));
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, Set<number>>();
    const vault = new Map([[provider.id, 'synthetic-old-key']]);
    const state: SaveRaceFixture = {
      calls: [], vaultPending: false, readPending: false, bodyDelivered: false,
      releaseVault: () => undefined, releaseOldBody: () => undefined,
      emitClipboard: text => {
        for (const id of listeners.get('fastdict://clipboard') || []) callbacks.get(id)?.({ event: 'fastdict://clipboard', id, payload: text });
      },
    };
    let nextId = 0;
    let readCount = 0;
    Object.assign(window, {
      providerSaveRace: state,
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: (callback: (event: unknown) => void) => { const id = ++nextId; callbacks.set(id, callback); return id; },
        unregisterCallback: (id: number) => { callbacks.delete(id); },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          state.calls.push({ command, args: { ...args } });
          if (command === 'get_api_key') return vault.get(args.providerId as string) ?? null;
          if (command === 'save_api_key') {
            state.vaultPending = true;
            await new Promise<void>(resolve => { state.releaseVault = resolve; });
            vault.set(args.providerId as string, args.apiKey as string);
            state.vaultPending = false;
            return;
          }
          if (command === 'delete_api_key') { vault.delete(args.providerId as string); return; }
          if (command === 'get_desktop_preferences') return { closeAction: 'quit', launchAtLogin: false, trayAvailable: true, autostartAvailable: true };
          if (command === 'get_shortcut_status') return { captureShortcut: 'Ctrl+Shift+S', clipboardShortcut: 'Ctrl+Shift+D', error: null };
          if (command === 'plugin:event|listen') {
            const event = args.event as string, id = args.handler as number;
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(id); return id;
          }
          if (command === 'plugin:event|unlisten') { listeners.get(args.event as string)?.delete(args.eventId as number); return; }
          if (['frontend_ready', 'report_boot_error'].includes(command)) return;
          if (command === 'plugin:http|fetch') return 101;
          if (command === 'plugin:http|fetch_send') return { status: 200, statusText: 'OK', url: 'https://old.example/v1/chat/completions', headers: [['content-type', 'text/event-stream']], rid: 102 };
          if (command === 'plugin:http|fetch_read_body') {
            if (readCount++) return [1];
            state.readPending = true;
            await new Promise<void>(resolve => { state.releaseOldBody = resolve; });
            state.bodyDelivered = true;
            // Deliberately deliver valid old text even after cancellation. A
            // late transport completion must not re-enter output or history.
            const body = 'data: {"choices":[{"delta":{"content":"STALE_TRANSLATION_MUST_NOT_APPEAR"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
            return [...new TextEncoder().encode(body), 0];
          }
          if (command === 'plugin:http|fetch_cancel' || command === 'plugin:http|fetch_cancel_body') return;
          throw new Error('Unexpected provider-save fixture IPC: ' + command);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
    });
  });

  await page.goto('/');
  await page.getByRole('textbox', { name: '待翻译文本' }).fill('Synthetic request started during a slow credential save.');
  await page.getByRole('button', { name: /^偏好设置/ }).click();
  await page.locator('.settings-provider').filter({ hasText: 'Original service' }).click();
  const editor = page.getByRole('dialog', { name: 'API 服务配置', exact: true });
  await editor.getByLabel('服务名称', { exact: true }).fill('Committed service');
  await editor.getByLabel(/^API 地址/).fill('https://new.example/v1');
  await editor.getByPlaceholder('输入新密钥以替换').fill('synthetic-new-key');
  await editor.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { providerSaveRace: SaveRaceFixture }).providerSaveRace.vaultPending)).toBe(true);

  // Native OS shortcuts may arrive while the editor is saving. The workspace
  // Ctrl+Enter shortcut is now correctly scoped to the translation view.
  await page.evaluate(() => (window as unknown as { providerSaveRace: SaveRaceFixture }).providerSaveRace.emitClipboard('Synthetic OS clipboard input during credential save.'));
  await expect.poll(() => page.evaluate(() => (window as unknown as { providerSaveRace: SaveRaceFixture }).providerSaveRace.readPending)).toBe(true);
  const oldRequest = await page.evaluate(() => (window as unknown as { providerSaveRace: SaveRaceFixture }).providerSaveRace.calls.find(call => call.command === 'plugin:http|fetch'));
  expect(oldRequest?.args.clientConfig).toMatchObject({ url: 'https://old.example/v1/chat/completions' });
  expect((oldRequest?.args.clientConfig as { headers: string[][] }).headers).toContainEqual(['authorization', 'Bearer synthetic-old-key']);

  await page.evaluate(() => (window as unknown as { providerSaveRace: SaveRaceFixture }).providerSaveRace.releaseVault());
  await expect(editor).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as unknown as { providerSaveRace: SaveRaceFixture }).providerSaveRace.calls.some(call => call.command === 'plugin:http|fetch_cancel'))).toBe(true);
  const committed = await page.evaluate(() => JSON.parse(localStorage.getItem('fastdict.v1.configuration')!));
  expect(committed.providers[0]).toMatchObject({ name: 'Committed service', baseUrl: 'https://new.example/v1', hasKey: true });
  expect(committed.providers[0].credentialId).not.toBe('save-race-provider');
  await page.getByRole('button', { name: /^即时翻译/ }).click();
  await expect(page.getByRole('button', { name: '翻译', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);

  await page.evaluate(() => (window as unknown as { providerSaveRace: SaveRaceFixture }).providerSaveRace.releaseOldBody());
  await expect.poll(() => page.evaluate(() => (window as unknown as { providerSaveRace: SaveRaceFixture }).providerSaveRace.bodyDelivered)).toBe(true);
  // Drain delivery and a React render opportunity without a fixed sleep.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.translation-output')).toHaveCount(0);
  await expect(page.getByText('STALE_TRANSLATION_MUST_NOT_APPEAR', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fastdict.v1.history') || '[]'))).toEqual([]);
});
