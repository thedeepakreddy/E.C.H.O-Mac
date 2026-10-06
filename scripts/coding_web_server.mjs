import http from 'node:http';import {readFile,lstat,realpath} from 'node:fs/promises';import {resolve,relative,sep,extname} from 'node:path';
const root=await realpath(process.argv[2]);const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{try{
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
 const url=new URL(req.url,'http://localhost');const requested=decodeURIComponent(url.pathname);if(requested.split('/').some(x=>x.startsWith('.')||x==='node_modules'))throw Error('Forbidden');
 let path=resolve(root,`.${requested}`);let rel=relative(root,path);if(rel==='..'||rel.startsWith(`..${sep}`))throw Error('Forbidden');
 let current=root;for(const part of rel.split(sep).filter(Boolean)){current=resolve(current,part);if((await lstat(current)).isSymbolicLink())throw Error('Forbidden');}
 if((await lstat(path)).isDirectory())path=resolve(path,'index.html');
 if((await lstat(path)).isSymbolicLink())throw Error('Forbidden');
 const body=await readFile(path);res.writeHead(200,{'Content-Type':types[extname(path)]??'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:body);
 }catch(error){res.writeHead(error.message==='Forbidden'?403:404);res.end('Unavailable');}});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({echoPreviewReady:true,url:`http://127.0.0.1:${server.address().port}`})));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
