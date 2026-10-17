import { expect, test, type Page } from '@playwright/test';

async function install(page: Page) {
  const requests: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('fastdict.v1.providers', JSON.stringify([
      { id: 'local', name: 'Local', kind: 'openai', model: 'translator', baseUrl: 'http://localhost:11434/v1', hasKey: false },
      { id: 'unconfigured', name: 'Needs key', kind: 'openai', model: 'translator', baseUrl: 'https://api.example.com/v1', hasKey: false },
    ]));
    localStorage.setItem('fastdict.v1.preferences', JSON.stringify({ activeProviderId: 'local', autoTranslate: false }));
  });
  await page.route('**/v1/chat/completions', async route => {
    requests.push(route.request().postData() || '');
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"译文"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' });
  });
  await page.goto('/');
  await page.getByRole('textbox', { name: '待翻译文本' }).fill('Original text');
  return requests;
}

test('translation shortcuts do not send requests from settings or provider dialogs', async ({ page }) => {
  const requests = await install(page);
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  await page.getByRole('button', { name: '编辑翻译提示词' }).click();
  await page.getByRole('textbox', { name: '翻译提示词', exact: true }).press('Control+Enter');
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.locator('.settings-provider').filter({ hasText: 'Local' }).click();
  await page.getByLabel('模型名称', { exact: true }).press('Control+Enter');
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: '关闭配置' }).click();
  await page.getByRole('button', { name: '即时翻译', exact: true }).click();
  await page.getByRole('textbox', { name: '待翻译文本' }).press('Control+Enter');
  await expect(page.locator('.translation-output')).toHaveText('译文');
  expect(requests).toHaveLength(1);
});

test('readiness describes the selected provider rather than an unrelated configured service', async ({ page }) => {
  await install(page);
  await expect(page.locator('.availability')).toHaveText('随时就绪');
  await page.getByRole('combobox', { name: '翻译服务', exact: true }).selectOption('unconfigured');
  await expect(page.locator('.availability')).toHaveText('等待连接服务');
  await page.getByRole('combobox', { name: '翻译服务', exact: true }).selectOption('local');
  await expect(page.locator('.availability')).toHaveText('随时就绪');
});

test('holding the shortcut and composing text cannot start duplicate translation requests', async ({ page }) => {
  const requests = await install(page);
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, repeat: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true }));
  });
  await expect(page.locator('.translation-output')).toHaveCount(0);
  expect(requests).toHaveLength(0);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let count = 0;
  await page.route('**/v1/chat/completions', async route => {
    ++count;
    await gate;
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' });
  });
  const input = page.getByRole('textbox', { name: '待翻译文本' });
  try {
    await input.press('Control+Enter');
    await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    await input.press('Control+Enter');
    await input.press('Control+Enter');
    expect(count).toBe(1);
  } finally { release(); }
  await expect(page.locator('.translation-output')).toHaveText('完成');
});

test('provider dialogs contain keyboard focus and restore it on dismissal', async ({ page }) => {
  await install(page);
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  const trigger = page.locator('.settings-provider').filter({ hasText: 'Local' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'API 服务配置', exact: true });
  await expect(dialog.getByLabel('服务名称', { exact: true })).toBeFocused();
  const first = dialog.getByRole('button', { name: '关闭配置' });
  const last = dialog.getByRole('button', { name: '保存配置', exact: true });
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('native input keeps an unsaved provider draft in one usable dialog', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    localStorage.setItem('fastdict.v1.preferences', JSON.stringify({ autoTranslate: true, ocrLang: 'eng' }));
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, Set<number>>();
    let nextId = 0;
    Object.assign(window, {
      emitReviewClipboard: () => {
        for (const id of listeners.get('fastdict://clipboard') || []) callbacks.get(id)?.({ event: 'fastdict://clipboard', id, payload: 'Synthetic clipboard input' });
      },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback: (callback: (event: unknown) => void) => { const id = ++nextId; callbacks.set(id, callback); return id; },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'plugin:event|listen') {
            const event = args.event as string, id = args.handler as number;
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(id); return id;
          }
          if (command === 'plugin:event|unlisten') { listeners.get(args.event as string)?.delete(args.eventId as number); return; }
          if (command === 'get_shortcut_status') return { captureShortcut: 'Ctrl+Shift+S', clipboardShortcut: 'Ctrl+Shift+D', error: null };
          if (['frontend_ready', 'report_boot_error'].includes(command)) return;
          throw new Error('Unexpected review command: ' + command);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '添加翻译服务', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /OpenAI OpenAI 兼容接口/ }).click();
  const dialog = page.getByRole('dialog', { name: 'API 服务配置', exact: true });
  await dialog.getByLabel('服务名称', { exact: true }).fill('Unsaved draft');
  await page.evaluate(() => (window as unknown as { emitReviewClipboard: () => void }).emitReviewClipboard());
  await expect(page.locator('.error-banner')).toContainText('请先添加并配置翻译服务');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(dialog.getByLabel('服务名称', { exact: true })).toHaveValue('Unsaved draft');
  await dialog.getByLabel('模型名称', { exact: true }).fill('still-editable');
  await dialog.getByRole('button', { name: '关闭配置' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).toHaveValue('Synthetic clipboard input');
  expect(errors).toEqual([]);
});
