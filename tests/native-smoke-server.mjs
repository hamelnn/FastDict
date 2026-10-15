// Local fixture for manually exercising the compiled Windows app. No production
// code is mocked: the app captures this displayed text, OCRs it and requests SSE.
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const server=createServer((request,response)=>{
  if(request.method==='GET'){
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    response.end('<!doctype html><html><head><title>FastDict Native Capture Fixture</title><style>body{margin:0;background:white;color:#151515;font-family:Arial,sans-serif}main{padding:100px 80px}h1{font-size:20px;font-weight:400;color:#888;margin:0 0 100px}p{font-size:80px;margin:0;white-space:nowrap}small{display:block;color:#888;margin-top:100px}</style></head><body><main><h1>FastDict Windows native screenshot test</h1><p>Hello world</p><small>Select only the large text. This is a local test page.</small></main></body></html>');return;
  }
  if(request.method!=='POST'||request.url!=='/v1/chat/completions'){response.writeHead(404);response.end();return;}
  let body='';request.on('data',chunk=>body+=chunk);request.on('end',async()=>{
    let payload;try{payload=JSON.parse(body);}catch{response.writeHead(400);response.end();return;}
    const source=payload.messages?.at(-1)?.content||'';
    await writeFile(resolve(root,'native-test-results/request.json'),JSON.stringify({source,model:payload.model,at:new Date().toISOString()},null,2));
    response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    const parts=/hello world/i.test(source)?['你好','，世界。']:['已收到','截图识别文本。'];
    response.write(`data: ${JSON.stringify({choices:[{delta:{content:parts[0]}}]})}\n\n`);
    setTimeout(()=>response.end(`data: ${JSON.stringify({choices:[{delta:{content:parts[1]}}]})}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`),400);
  });
});
await mkdir(resolve(root,'native-test-results'),{recursive:true});
server.listen(0,'127.0.0.1',async()=>{const address=server.address();const url=`http://127.0.0.1:${address.port}`;await writeFile(resolve(root,'native-test-results/server.json'),JSON.stringify({url}));process.stdout.write(`Native test fixture and API: ${url}\n`);});
