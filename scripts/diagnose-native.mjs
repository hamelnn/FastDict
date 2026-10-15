// Read-only diagnostics for the local FastDict WebView. Never prints user text or settings.
const pages = await (await fetch('http://127.0.0.1:9223/json/list')).json();
for (const page of pages.filter(item => item.type === 'page')) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  const events = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } else if (message.method === 'Runtime.exceptionThrown') {
      const exception = message.params.exceptionDetails;
      events.push({ type: 'exception', name: exception.exception?.className, source: exception.url, line: exception.lineNumber });
    } else if (message.method === 'Log.entryAdded') {
      const entry = message.params.entry;
      events.push({ type: 'log', level: entry.level, source: entry.source, url: entry.url });
    }
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const send = (method, params = {}) => new Promise(resolve => {
    const id = ++sequence;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Log.enable');
  const result = await send('Runtime.evaluate', { expression: `JSON.stringify({
    ready: document.readyState,
    rootChildren: document.getElementById('root')?.childElementCount,
    rootTextLength: document.getElementById('root')?.textContent?.length,
    viewport: {width: innerWidth, height: innerHeight},
    scripts: [...document.scripts].map(s => s.src),
    failedResources: performance.getEntriesByType('resource').filter(r => r.responseStatus >= 400).map(r => ({url:r.name, status:r.responseStatus})),
    storageBytes: (() => { try { return Object.keys(localStorage).filter(k => k.startsWith('fastdict.')).reduce((n,k) => n + localStorage.getItem(k).length * 2, 0); } catch { return 'unavailable'; } })()
  })`, returnByValue: true });
  console.log(JSON.stringify({ url: page.url, diagnostic: result.result?.result?.value, events }, null, 2));
  socket.close();
}
