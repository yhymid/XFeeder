"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const https=require('node:https');
const {once}=require('node:events');
const {startDashboard}=require('../src/dashboard/server');
test('HTTPS reverse proxy supports login, Network save and logout; forged origins are rejected',{timeout:15000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xfeeder-tls-proxy-'));
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({channels:[]}));
 const password=process.env.XFEEDER_DASHBOARD_PASSWORD;process.env.XFEEDER_DASHBOARD_PASSWORD='fixture-password';
 const cert=fs.readFileSync(path.join(__dirname,'fixtures/tls/localhost-test-cert.pem'));
 const key=fs.readFileSync(path.join(__dirname,'fixtures/tls/localhost-test-key.pem'));
 let backend;
 const proxy=https.createServer({key,cert},(req,res)=>{
  const target=http.request({hostname:'127.0.0.1',port:backend.address().port,path:req.url,method:req.method,headers:{...req.headers,host:'internal.invalid','x-forwarded-proto':'https'}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
  target.on('error',()=>{res.writeHead(502);res.end();});req.pipe(target);
 });
 t.after(async()=>{
  if(backend){backend.closeAllConnections();await new Promise(r=>backend.close(r));}
  proxy.closeAllConnections();await new Promise(r=>proxy.close(r));
  if(password===undefined)delete process.env.XFEEDER_DASHBOARD_PASSWORD;else process.env.XFEEDER_DASHBOARD_PASSWORD=password;
  fs.rmSync(dir,{recursive:true,force:true});
 });
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
 const origin=`https://127.0.0.1:${proxy.address().port}`;
 backend=startDashboard({port:0,dataDir:dir,publicOrigin:origin});await once(backend,'listening');
 const request=(pathname,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const req=https.request(origin+pathname,{ca:cert,method,headers:{Origin:origin,...headers}},res=>{let data='';res.on('data',b=>data+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(data)}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
 });
 const login=await request('/api/login',{method:'POST',body:{password:'fixture-password'}});
 assert.equal(login.status,200);const cookie=login.headers['set-cookie'][0];assert.match(cookie,/; Secure/);assert.match(cookie,/HttpOnly/);
 const headers={Cookie:cookie.split(';')[0]};
 const settings=await request('/api/settings/network',{headers});assert.equal(settings.status,200);
 const save=await request('/api/settings/network',{method:'PUT',headers:{...headers,'If-Match':`"${settings.data.revision}"`},body:{bandwidthProfile:'medium'}});assert.equal(save.status,200);
 const evil=await request('/api/login',{method:'POST',headers:{Origin:'https://evil.example','X-Forwarded-Host':origin.slice(8)},body:{password:'fixture-password'}});assert.equal(evil.status,403);
 const logout=await request('/api/logout',{method:'POST',headers});assert.equal(logout.status,200);assert.match(logout.headers['set-cookie'][0],/; Secure/);assert.equal((await request('/api/settings/network',{headers})).status,401);
});
