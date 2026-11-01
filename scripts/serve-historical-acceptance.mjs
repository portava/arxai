// Read-only frozen fixture. Never forwards API traffic or reads credentials.
import http from "node:http";
import {readFile, stat} from "node:fs/promises";
import path from "node:path";
const root=path.resolve("generated-artifacts/arx-historical-fibonacci-validation/scratch/arxai/scripts/node_modules/.scanner-shared-chart-qa/28ccd598d091581c");
http.createServer(async(req,res)=>{
  const url=new URL(req.url,"http://127.0.0.1:4199");
  if(req.method!=="GET"||url.pathname.startsWith("/api/")){
    res.writeHead(503,{"content-type":"application/json"});
    res.end('{"error":"OFFLINE_NO_API"}');return;
  }
  let file=path.resolve(root,"."+url.pathname);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{if((await stat(file)).isDirectory())file=path.join(file,"index.html");}
  catch{file=path.join(root,"index.html");}
  try{
    const types={".html":"text/html",".js":"text/javascript",".json":"application/json",".css":"text/css",".svg":"image/svg+xml",".png":"image/png",".woff2":"font/woff2"};
    res.writeHead(200,{"content-type":types[path.extname(file)]??"application/octet-stream","cache-control":"no-store"});
    res.end(await readFile(file));
  }catch{res.writeHead(404);res.end();}
}).listen(4199,"127.0.0.1",()=>console.log("Frozen historical acceptance fixture on 127.0.0.1:4199; no API proxy"));
