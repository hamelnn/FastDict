import { test, expect } from '@playwright/test';

test('real OCR workers terminate after missing and corrupt models and recover with repaired local resources', async ({ page }) => {
  // The wrapper observes native Worker ownership; model parsing and WASM run in
  // the actual packaged worker, without replacing the OCR application module.
  await page.addInitScript(() => {
    localStorage.setItem('fastdict.v1.preferences', JSON.stringify({ warmOcr: false, ocrLang: 'eng' }));
    const audit = { created: 0, active: 0, terminated: 0 };
    (window as unknown as { ocrWorkerAudit: typeof audit }).ocrWorkerAudit = audit;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private readonly tracked: boolean;
      private stopped = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.tracked = new URL(String(url), location.href).pathname.endsWith('/ocr/worker.min.js');
        if (this.tracked) { audit.created++; audit.active++; }
      }
      override terminate() {
        if (this.tracked && !this.stopped) { this.stopped = true; audit.active--; audit.terminated++; }
        super.terminate();
      }
    };
  });
  let corrupt = false;
  await page.route('**/ocr/lang/eng.traineddata.gz', route => route.fulfill({ status: corrupt ? 200 : 404, body: corrupt ? 'corrupt traineddata' : 'missing model' }));
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '待翻译文本' })).toBeVisible();
  for (let attempt = 0; attempt < 3; attempt++) {
    corrupt = attempt === 2;
    const error = await page.evaluate(async () => {
      // @ts-expect-error Vite serves this production module to the browser.
      const ocr = await import('/src/lib/ocr.ts');
      try { await ocr.warmOcr('eng'); return ''; }
      catch (failure) { return failure instanceof Error ? failure.message : String(failure); }
    });
    expect(error).toContain('OCR 引擎加载失败');
    expect(await page.evaluate(() => (window as unknown as { ocrWorkerAudit: { created: number; active: number; terminated: number } }).ocrWorkerAudit)).toEqual({ created: attempt + 1, active: 0, terminated: attempt + 1 });
  }
  await page.unroute('**/ocr/lang/eng.traineddata.gz');
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite serves this production module to the browser.
    const ocr = await import('/src/lib/ocr.ts');
    const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 220;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000000'; context.font = '80px Arial'; context.fillText('Hello world', 40, 135);
    const recognized = await ocr.recognizeImage(canvas.toDataURL('image/png'), 'eng');
    await ocr.disposeOcr();
    return recognized;
  });
  expect(result.text).toMatch(/hello world/i);
  expect(await page.evaluate(() => (window as unknown as { ocrWorkerAudit: { created: number; active: number; terminated: number } }).ocrWorkerAudit)).toEqual({ created: 4, active: 0, terminated: 4 });
});
