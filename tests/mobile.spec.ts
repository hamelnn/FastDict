import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

type MobileOS = 'ios' | 'android';
interface MobileCall { command: string; args: Record<string, unknown>; }

async function installMobile(page: Page, os: MobileOS) {
  await page.addInitScript(({ os }) => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: os === 'ios' ? 'iPhone' : 'Linux armv8l' });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    const provider = { id: 'mobile-test', name: '移动测试服务', kind: 'openai', baseUrl: 'https://mobile.example/v1', model: 'mobile-test-model', hasKey: true };
    localStorage.setItem('fastdict.v1.providers', JSON.stringify([provider]));
    localStorage.setItem('fastdict.v1.preferences', JSON.stringify({ sourceLang: 'auto', targetLang: 'zh-CN', ocrLang: 'eng', autoTranslate: true, activeProviderId: provider.id }));
    const calls: MobileCall[] = [];
    const vault = new Map([[provider.id, 'mobile-test-only-key']]);
    const reads = new Map<number, number>();
    let rid = 0;
    const fixture = { calls, image: null as { dataUrl: string; width: number; height: number } | null, holdStream: false, holdPicker: false, resolvePicker: null as (() => void) | null };
    Object.assign(window, {
      mobileTest: fixture,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: { ...args } });
          if (command === 'get_api_key') return vault.get(args.providerId as string) ?? null;
          if (command === 'save_api_key') { vault.set(args.providerId as string, args.apiKey as string); return; }
          if (command === 'delete_api_key') { vault.delete(args.providerId as string); return; }
          if (command === 'read_clipboard') return 'Hello world';
          if (command === 'write_clipboard' || command === 'mobile_share_text' || command === 'report_boot_error') return;
          if (command === 'mobile_pick_image') {
            if (fixture.holdPicker) await new Promise<void>(resolve => { fixture.resolvePicker = resolve; });
            return fixture.image;
          }
          if (command === 'plugin:http|fetch') return ++rid;
          if (command === 'plugin:http|fetch_send') return { status: 200, statusText: 'OK', url: provider.baseUrl + '/chat/completions', headers: [['content-type', 'text/event-stream']], rid: args.rid };
          if (command === 'plugin:http|fetch_read_body') {
            const count = reads.get(args.rid as number) || 0;
            reads.set(args.rid as number, count + 1);
            if (count && fixture.holdStream) return new Promise(() => undefined);
            if (count) return [1];
            const delta = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '你好，世界。' } }] }) + '\n\n';
            const end = fixture.holdStream ? '' : 'data: [DONE]\n\n';
            return [...new TextEncoder().encode(delta + end), 0];
          }
          if (command === 'plugin:http|fetch_cancel' || command === 'plugin:http|fetch_cancel_body') return;
          throw new Error('Unexpected mobile IPC: ' + command);
        },
      },
    });
  }, { os });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '移动导航' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).toBeVisible();
}

async function calls(page: Page, command: string): Promise<MobileCall[]> {
  return page.evaluate(command => (window as unknown as { mobileTest: { calls: MobileCall[] } }).mobileTest.calls.filter(call => call.command === command), command);
}

async function navigate(page: Page, name: string) {
  await page.getByRole('navigation', { name: '移动导航' }).getByRole('button', { name, exact: true }).click();
}

async function prepareImage(page: Page) {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 180;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 900, 180);
    context.fillStyle = '#111111'; context.font = '64px Arial'; context.fillText('Hello world', 45, 110);
    (window as unknown as { mobileTest: { image: unknown } }).mobileTest.image = { dataUrl: canvas.toDataURL('image/png'), width: 900, height: 180 };
  });
}

for (const os of ['ios', 'android'] as const) {
  test.describe(`${os} mobile app`, () => {
    test.use({
      viewport: os === 'ios' ? { width: 390, height: 844 } : { width: 412, height: 915 },
      isMobile: true, hasTouch: true,
      userAgent: os === 'ios'
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
        : 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/134.0 Mobile Safari/537.36',
    });

    test('pastes, translates, shares and navigates without desktop actions or background clipboard reads', async ({ page }) => {
      await installMobile(page, os);
      expect(await calls(page, 'read_clipboard')).toHaveLength(0);
      expect(await calls(page, 'get_shortcut_status')).toHaveLength(0);
      expect(await calls(page, 'frontend_ready')).toHaveLength(0);
      await expect(page.getByRole('button', { name: '浏览器截图体验' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '展开工作空间' })).toHaveCount(0);
      await page.getByRole('button', { name: '粘贴文本', exact: true }).click();
      await expect(page.locator('.translation-output')).toHaveText('你好，世界。');
      await page.getByRole('button', { name: '分享译文', exact: true }).click();
      await expect.poll(async () => (await calls(page, 'mobile_share_text')).length).toBe(1);
      expect((await calls(page, 'mobile_share_text'))[0].args.text).toBe('你好，世界。');
      await page.getByRole('button', { name: '复制译文', exact: true }).click();
      await expect.poll(async () => (await calls(page, 'write_clipboard')).length).toBe(1);
      await navigate(page, '翻译记录');
      await expect(page.locator('.history-card')).toHaveCount(1);
      await navigate(page, '偏好设置');
      await expect(page.locator('#quickstart')).not.toContainText('Ctrl');
      await expect(page.getByRole('button', { name: '退出轻译' })).toHaveCount(0);
      await page.getByRole('button', { name: /移动测试服务/ }).click();
      const editor = page.getByRole('dialog', { name: 'API 服务配置' });
      await editor.getByPlaceholder('输入新密钥以替换').fill('mobile-replacement-test-key');
      await editor.getByRole('button', { name: '保存配置', exact: true }).click();
      await expect(editor).toBeHidden();
      await expect.poll(async () => (await calls(page, 'save_api_key')).length).toBe(1);
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('mobile-replacement-test-key');
      await navigate(page, '即时翻译');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(os === 'ios' ? 390 : 412);
      await expect(page.getByRole('status')).toBeHidden();
      await mkdir(resolve('native-test-results'), { recursive: true });
      await page.screenshot({ path: resolve(`native-test-results/${os}-mobile-preview.png`), fullPage: false });
    });

    test('imports from the native picker, handles dismissal and runs the real local OCR pipeline', async ({ page }) => {
      await installMobile(page, os);
      const source = page.getByRole('textbox', { name: '待翻译文本' });
      await source.fill('Keep this text');
      await page.getByRole('button', { name: '选取截图', exact: true }).click();
      await expect(source).toHaveValue('Keep this text');
      expect(await calls(page, 'mobile_pick_image')).toHaveLength(1);
      expect(await calls(page, 'start_capture')).toHaveLength(0);
      await prepareImage(page);
      await page.getByRole('button', { name: '选取截图', exact: true }).click();
      await expect(source).toHaveValue(/hello world/i);
      await expect(page.locator('.translation-output')).toHaveText('你好，世界。');
      expect(await calls(page, 'mobile_pick_image')).toHaveLength(2);
      expect(await calls(page, 'plugin:http|fetch')).toHaveLength(1);
    });

    test('does not cancel the selected image when the system picker temporarily backgrounds the app', async ({ page }) => {
      await installMobile(page, os);
      await prepareImage(page);
      await page.evaluate(() => { (window as unknown as { mobileTest: { holdPicker: boolean } }).mobileTest.holdPicker = true; });
      await page.getByRole('button', { name: '选取截图', exact: true }).click();
      await expect.poll(async () => (await calls(page, 'mobile_pick_image')).length).toBe(1);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange'));
        (window as unknown as { mobileTest: { resolvePicker: () => void } }).mobileTest.resolvePicker();
      });
      await expect(page.locator('.translation-output')).toHaveText('你好，世界。');
    });

    test('stops an active translation when backgrounded and retains partial text', async ({ page }) => {
      await installMobile(page, os);
      await page.evaluate(() => { (window as unknown as { mobileTest: { holdStream: boolean } }).mobileTest.holdStream = true; });
      await page.getByRole('button', { name: '粘贴文本', exact: true }).click();
      await expect(page.getByRole('button', { name: '停止', exact: true })).toBeVisible();
      await expect(page.locator('.translation-output')).toHaveText('你好，世界。');
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect(page.getByRole('button', { name: '停止', exact: true })).toBeHidden();
      expect(await calls(page, 'plugin:http|fetch_cancel')).toHaveLength(1);
      await expect(page.locator('.translation-output')).toHaveText('你好，世界。');
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fastdict.v1.history') || '[]'))).toHaveLength(0);
    });

    test('keeps recovery available without exposing desktop quit shortcuts', async ({ page }) => {
      await page.route(url => url.pathname === '/src/App.tsx', route => route.fulfill({ contentType: 'text/javascript', body: 'throw Error("mobile fixture boot failure"); export default function(){}' }));
      await page.goto('/');
      const recovery = page.locator('#fastdict-boot-error');
      await expect(recovery).toBeVisible();
      await expect(recovery.getByRole('button', { name: '重新加载', exact: true })).toBeVisible();
      await expect(recovery.getByRole('button', { name: '退出应用', exact: true })).toBeHidden();
      await expect(recovery).not.toContainText('Ctrl');
      await expect(recovery).not.toContainText('⌘Q');
    });
  });
}
