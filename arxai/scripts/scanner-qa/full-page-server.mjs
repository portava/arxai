import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../artifacts/trading-dashboard/dist/public');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1:4198');
 if(url.pathname.startsWith('/api/')){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:'OFFLINE_API_NOT_INTERCEPTED'}));return;}
 let file=path.resolve(root,'.'+url.pathname);
 if(!file.startsWith(root+path.sep)){file=path.join(root,'index.html');}
 try{if((await stat(file)).isDirectory())file=path.join(file,'index.html');}catch{file=path.join(root,'index.html');}
 try{res.writeHead(200,{'content-type':types[path.extname(file)]??'application/octet-stream','cache-control':'no-store'});res.end(await readFile(file));}catch{res.writeHead(404);res.end();}
}).listen(4198,'127.0.0.1',()=>console.log('Read-only full-app build served on127.0.0.1:4198; no API proxy'));
