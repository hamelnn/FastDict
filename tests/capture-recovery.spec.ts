import { test, expect, type Page } from '@playwright/test';

async function installCapture(page: Page) {
  // The host state deliberately survives page.reload(), as the native session
  // does. This tests the fallback ready handshake, not a real fullscreen HWND.
  const host = { visible:false, active:true, calls:[] as { command:string; args:Record<string,unknown> }[] };
  await page.exposeFunction('captureRecoveryHost', (command:string,args:Record<string,unknown>) => {
    host.calls.push({ command,args });
    if (command === 'capture_ready') host.visible = true;
    if (command === 'cancel_capture' || command === 'recover_capture') { host.active = false; host.visible = false; }
    return { active:host.active,visible:host.visible };
  });
  await page.addInitScript(() => {
    const callbacks = new Map<number,(value:unknown)=>void>();
    const listeners = new Map<string,Set<number>>();
    let nextId = 1;
    const emit = (event:string,payload:unknown) => { for (const id of listeners.get(event) || []) callbacks.get(id)?.({ event,id,payload }); };
    const host = (window as unknown as { captureRecoveryHost:(command:string,args:Record<string,unknown>)=>Promise<{active:boolean;visible:boolean}> }).captureRecoveryHost;
    Object.assign(window,{
      __TAURI_INTERNALS__:{
        metadata:{ currentWindow:{label:'capture'},currentWebview:{label:'capture'} },
        transformCallback:(callback:(value:unknown)=>void) => { const id=nextId++; callbacks.set(id,callback); return id; },
        unregisterCallback:(id:number)=>callbacks.delete(id),
        invoke:async (command:string,args:Record<string,unknown>={}) => {
          if (command==='plugin:event|listen') {
            const event=args.event as string, id=args.handler as number;
            if (!listeners.has(event)) listeners.set(event,new Set());
            listeners.get(event)!.add(id); return id;
          }
          if (command==='plugin:event|unlisten') { listeners.get(args.event as string)?.delete(args.eventId as number); return; }
          const state=await host(command,args);
          if (command==='capture_overlay_ready') {
            if (state.active) queueMicrotask(()=>emit('fastdict://capture-start',{sessionId:41}));
            return;
          }
          if (command==='get_capture') {
            const canvas=document.createElement('canvas'); canvas.width=800; canvas.height=600;
            const context=canvas.getContext('2d')!; context.fillStyle='#fff'; context.fillRect(0,0,800,600);
            return { sessionId:41,dataUrl:canvas.toDataURL('image/png'),width:800,height:600 };
          }
          if (command==='cancel_capture' || command==='recover_capture') { emit('fastdict://capture-reset',{sessionId:41}); return; }
          if (command==='capture_ready' || command==='capture_boot_error') return;
          throw new Error(`Unexpected capture recovery command: ${command}`);
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__:{ unregisterListener:(event:string,id:number)=>{ listeners.get(event)?.delete(id); callbacks.delete(id); } },
    });
  });
  return host;
}

test('a new capture renderer can replay a previously visible session and cancel it',async ({page})=>{
  const host=await installCapture(page);
  await page.goto('/?capture=1');
  await expect(page.getByRole('dialog',{name:'选择截图区域'})).toBeVisible();
  await expect.poll(()=>host.visible).toBe(true);
  const initialReads=host.calls.filter(call=>call.command==='get_capture').length;
  await page.reload();
  await expect(page.getByRole('dialog',{name:'选择截图区域'})).toBeVisible();
  await expect.poll(()=>host.calls.filter(call=>call.command==='get_capture').length).toBeGreaterThan(initialReads);
  await page.keyboard.press('Escape');
  await expect.poll(()=>host.active).toBe(false);
  expect(host.visible).toBe(false);
  expect(host.calls.filter(call=>call.command==='cancel_capture').at(-1)?.args).toEqual({sessionId:41});
});

test('capture recovery reports a fixed stage and cancels its own window without global quit permission',async ({page})=>{
  const host=await installCapture(page);
  await page.goto('/?capture=1');
  await expect(page.getByRole('dialog',{name:'选择截图区域'})).toBeVisible();
  await page.evaluate(()=>window.__FASTD_BOOT__?.fail('react-render-failed'));
  const recovery=page.locator('#fastdict-boot-error');
  await expect(recovery).toBeVisible();
  await expect.poll(()=>host.calls.filter(call=>call.command==='capture_boot_error').length).toBe(1);
  expect(host.calls.find(call=>call.command==='capture_boot_error')?.args).toEqual({stage:'react-render-failed'});
  await recovery.getByRole('button',{name:'取消截图',exact:true}).click();
  await expect.poll(()=>host.active).toBe(false);
  expect(host.visible).toBe(false);
  expect(host.calls.filter(call=>call.command==='recover_capture')).toHaveLength(1);
  expect(host.calls.filter(call=>['quit_app','report_boot_error','get_api_key'].includes(call.command))).toEqual([]);
});
