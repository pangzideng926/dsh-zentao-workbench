/** Local regression: mock HTTP + two loopback fixtures, fake DPAPI/opener; no real services. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import http from 'node:http';
const temp = mkdtempSync(join(tmpdir(), 'dzw-security-'));
const config = join(temp, 'config.json');
process.env.DSH_ZENTAO_WORKBENCH_CONFIG = config;
process.env.DSH_ZENTAO_WORKBENCH_OPEN_DIR = join(temp, 'attachments');
const originals = { spawnSync: cp.spawnSync, spawn: cp.spawn, fetch: globalThis.fetch };
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
// Exercise the Windows credential branch on any test OS; no actual DPAPI is invoked.
Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
const seals = new Map();
let opens = 0;
cp.spawnSync = (_exe, args, options) => {
  const secret = options.env.DZW_SECRET;
  if (args.at(-1).includes('ConvertFrom-SecureString')) {
    const sealed = 'fixture-sealed-' + seals.size;
    seals.set(sealed, secret);
    return { status: 0, stdout: sealed + '\r\n', stderr: '' };
  }
  return { status: 0, stdout: (seals.get(secret) ?? '') + '\r\n', stderr: '' };
};
cp.spawn = () => { opens++; return Object.assign(new EventEmitter(), { unref() {} }); };
syncBuiltinESMExports();
let mock, requests = [];
globalThis.fetch = async (url, init = {}) => { requests.push({url:String(url),init}); return mock(String(url),init); };
const { apply } = await import('../lib/index.js');
const response = (body, status = 200, headers = {}) => new Response(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), {status,headers});
const deferred = () => { let resolve; const promise = new Promise(r=>resolve=r); return {promise,resolve}; };
function standard(url, init) {
  const p = new URL(url).pathname;
  if (p.endsWith('/tokens')) return response({token:JSON.parse(init.body).account === 'bob' ? 'B' : 'A'});
  if (p.endsWith('/user')) return response({user:{account:init.headers.Token === 'B' ? 'bob' : 'alice'}});
  throw Error('Unexpected mocked request: '+url);
}
function host(preserve = false) {
  if (!preserve && existsSync(config)) unlinkSync(config);
  let route;
  const ctx = {tools:{register(){}},reflect:{get(){}},effect(fn){return fn();},inject(_deps,fn){fn(this);},webServer:{register(r){route=r;}}};
  apply(ctx);
  return async (endpoint, payload = {}, headers = {}, method = 'POST') => {
    const req = Object.assign(new EventEmitter(), {method,url:'/zentao-workbench/'+endpoint,headers:{host:'127.0.0.1:19399','content-type':'application/json',...headers}});
    const res = {status:0,headers:{},body:'',writeHead(status,h){this.status=status;this.headers=h;},end(data){this.body=data?.toString()??'';}};
    const work = route.handler(req,res);
    req.emit('data',Buffer.from(JSON.stringify(payload)));req.emit('end');await work;
    try{res.json=JSON.parse(res.body);}catch{}
    return res;
  };
}
const login = (call,extra={}) => call('login',{server:'http://zentao.test/zentao',account:'alice',token:'A',...extra});
const attachment = (call,path='file-read-1.png',headers={}) => call('attachment?url='+encodeURIComponent('http://zentao.test/zentao/'+path),{},headers,'GET');
const tests=[];
function test(name,fn){tests.push({name,fn});}
const getConfig = async call => (await call('getConfig')).json.value;
test('credentials bind to server/account and never appear in getConfig',async()=>{
  const call=host();await login(call,{token:'',password:'fixture-secret',rememberPassword:true});
  const saved=JSON.parse(readFileSync(config,'utf8'));
  assert.equal(saved.passwordServer,'http://zentao.test/zentao');assert.equal(saved.passwordAccount,'alice');
  assert.equal(saved.rememberPassword,true);assert.ok(!JSON.stringify(saved).includes('fixture-secret'));
  assert.ok(!JSON.stringify(await getConfig(call)).includes('passwordEnc'));
});
test('switching server with Token clears old password and never reuses it',async()=>{
  const call=host();await login(call,{token:'',password:'fixture-secret',rememberPassword:true});
  await login(call,{server:'http://second.test/zentao',rememberPassword:true});
  assert.equal((await getConfig(call)).rememberPassword,false);
  const tokenCalls=requests.filter(r=>r.url.endsWith('/tokens')).length;
  mock=(url,init)=>url.endsWith('/tasks/1')?response({error:'Unauthorized'},401):standard(url,init);
  await call('fetchDetail',{kind:'task',id:'1'});
  assert.equal(requests.filter(r=>r.url.endsWith('/tokens')).length,tokenCalls);
  assert.equal(JSON.parse(readFileSync(config,'utf8')).passwordEnc,'');
});
test('switching account clears password; matching identity may retain it',async()=>{
  const call=host();await login(call,{token:'',password:'fixture-secret',rememberPassword:true});
  await login(call,{rememberPassword:true});assert.equal((await getConfig(call)).rememberPassword,true);
  await login(call,{account:'bob',token:'B',rememberPassword:true});
  assert.equal((await getConfig(call)).account,'bob');assert.equal((await getConfig(call)).rememberPassword,false);
});
test('token plus password does not store unvalidated password',async()=>{
  const call=host();await login(call,{password:'unvalidated',rememberPassword:true});
  assert.equal((await getConfig(call)).rememberPassword,false);
});
test('legacy and mismatched credential bindings require password login again',async()=>{
  const raw={server:'http://zentao.test/zentao',account:'alice',rememberToken:true,token:'A',rememberPassword:true,passwordScheme:'dpapi',passwordEnc:'legacy'};
  writeFileSync(config,JSON.stringify(raw));assert.equal((await getConfig(host(true))).rememberPassword,false);
  writeFileSync(config,JSON.stringify({...raw,passwordServer:raw.server,passwordAccount:'bob'}));
  assert.equal((await getConfig(host(true))).rememberPassword,false);
});
test('bound password reload preserves surrounding whitespace',async()=>{
  const call=host();await login(call,{token:'',password:'  fixture secret  ',rememberPassword:true});
  const loaded=host(true);await login(loaded,{rememberPassword:true});
  let tokenBody;
  mock=(url,init)=>{
    if(url.endsWith('/tokens'))tokenBody=JSON.parse(init.body);
    if(url.endsWith('/tasks/1'))return response({error:'Unauthorized'},401);
    return standard(url,init);
  };
  await loaded('fetchDetail',{kind:'task',id:'1'});assert.equal(tokenBody.password,'  fixture secret  ');
});
for(const action of ['logout','forgetPassword','switch'])test('late auto-login cannot override '+action,async()=>{
  const call=host();await login(call,{token:'',password:'fixture-secret',rememberPassword:true});
  const started=deferred(),release=deferred();
  mock=async(url,init)=>{
    if(url.endsWith('/tasks/1'))return response({error:'Unauthorized'},401);
    if(url.endsWith('/tokens')){started.resolve();await release.promise;return response({token:'A'});}
    return standard(url,init);
  };
  const pending=call('fetchDetail',{kind:'task',id:'1'});await started.promise;
  if(action==='switch')await login(call,{account:'bob',token:'B'});else await call(action);
  release.resolve();const result=await pending;
  assert.equal(result.json.ok,false);assert.equal(result.json.error.code,'auth-changed');
  const info=await getConfig(call);
  assert.equal(info.hasToken,action!=='logout');
  if(action==='switch')assert.equal(info.account,'bob');
  if(action==='forgetPassword')assert.equal(info.rememberPassword,false);
});
test('older manual login cannot override a newer login',async()=>{
  const call=host(),started=deferred(),release=deferred();
  mock=async(url,init)=>{if(url.endsWith('/user')&&init.headers.Token==='A'){started.resolve();await release.promise;}return standard(url,init);};
  const a=login(call);await started.promise;await login(call,{account:'bob',token:'B'});release.resolve();
  assert.equal((await a).json.error.code,'auth-changed');assert.equal((await getConfig(call)).account,'bob');
});
test('late unauthorized response cannot clear newer login',async()=>{
  const call=host();await login(call);const started=deferred(),release=deferred();
  mock=async(url,init)=>{if(url.endsWith('/tasks/1')){started.resolve();await release.promise;return response({},401);}return standard(url,init);};
  const pending=call('fetchDetail',{kind:'task',id:'1'});await started.promise;await login(call,{token:'B',account:'bob'});release.resolve();
  await pending;assert.equal((await getConfig(call)).hasToken,true);assert.equal((await getConfig(call)).account,'bob');
});
test('REST cross-origin redirects never send token to destination',async()=>{
  const call=host();await login(call);requests=[];
  mock=(url,init)=>url.endsWith('/tasks/1')?response('',302,{location:'http://other.test/target'}):standard(url,init);
  const r=await call('fetchDetail',{kind:'task',id:'1'});assert.equal(r.json.error.code,'forbidden');
  assert.equal(requests.length,1);assert.equal(requests[0].init.redirect,'manual');
});
test('login POST redirect never replays password',async()=>{
  const call=host();mock=()=>response('',307,{location:'http://other.test/tokens'});
  const r=await login(call,{token:'',password:'fixture-secret'});assert.equal(r.json.error.code,'forbidden');assert.equal(requests.length,1);
});
test('real loopback HTTP follows permitted redirects but never contacts cross-origin sink',async()=>{
  let sinkRequests=0,downloadToken;
  const sink=http.createServer((_req,res)=>{sinkRequests++;res.end('sink');});
  const source=http.createServer((req,res)=>{
    if(req.url.endsWith('/user')){res.setHeader('content-type','application/json');res.end(JSON.stringify({user:{account:'alice'}}));}
    else if(req.url.endsWith('file-read-1.png')){res.writeHead(302,{location:`http://127.0.0.1:${sink.address().port}/zentao/file-read-2.png`});res.end();}
    else if(req.url.endsWith('file-read-3.png')){res.writeHead(302,{location:'file-read-2.png'});res.end();}
    else {downloadToken=req.headers.token;res.writeHead(200,{'content-type':'image/png'});res.end(Buffer.from([137,80,78,71]));}
  });
  const listen=s=>new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});
  try {
    await listen(sink);await listen(source);
    const origin=`http://127.0.0.1:${source.address().port}`;
    mock=(url,init)=>{assert.equal(new URL(url).origin,origin);return originals.fetch(url,init);};
    const call=host();await login(call,{server:origin+'/zentao'});
    const get=name=>call('attachment?url='+encodeURIComponent(origin+'/zentao/'+name),{}, {},'GET');
    assert.equal((await get('file-read-1.png')).status,403);assert.equal(sinkRequests,0);
    assert.equal((await get('file-read-3.png')).status,200);assert.equal(downloadToken,'A');
  } finally {source.closeAllConnections();sink.closeAllConnections();source.close();sink.close();}
});
test('attachment redirects enforce both origin and deployment path',async()=>{
  const call=host();await login(call);
  for(const destination of ['http://other.test/zentao/file-read-2.png','/outside/file-read-2.png','/zentao/api.php/v1/tasks']){
    requests=[];mock=()=>response('',302,{location:destination});
    assert.equal((await attachment(call)).status,403);assert.equal(requests.length,1);
  }
});
test('same-origin valid attachment redirect works; loops are bounded',async()=>{
  const call=host();await login(call);requests=[];
  mock=url=>url.endsWith('1.png')?response('',302,{location:'file-read-2.png'}):response(new Uint8Array([137,80,78,71]),200,{'content-type':'image/png'});
  assert.equal((await attachment(call)).status,200);assert.equal(requests.length,2);
  assert.equal(requests[1].init.headers.Token,'A');
  requests=[];mock=()=>response('',302,{location:'file-read-1.png'});
  assert.equal((await attachment(call)).status,403);assert.equal(requests.length,4);
});
test('HTML/SVG and HTML masquerading as PDF are downloads with isolation headers',async()=>{
  const call=host();await login(call);
  for(const [name,type,body] of [['1.html','text/html','<html>fixture</html>'],['1.svg','image/svg+xml','<svg/>'],['1.pdf','application/pdf','<!doctype html><html>fixture</html>']]){
    mock=()=>response(body,200,{'content-type':type});const r=await attachment(call,'file-read-'+name);
    assert.equal(r.headers['content-disposition'],'attachment');assert.equal(r.headers['content-type'],'application/octet-stream');
    assert.equal(r.headers['x-content-type-options'],'nosniff');assert.match(r.headers['content-security-policy'],/sandbox/);assert.match(r.headers['cache-control'],/no-store/);
  }
});
test('valid PDF remains inline; GET-only attachment route',async()=>{
  const call=host();await login(call);mock=()=>response('%PDF-1.7\nfixture',200,{'content-type':'application/pdf'});
  assert.equal((await attachment(call,'file-read-1.pdf')).headers['content-disposition'],'inline');
  assert.equal((await call('attachment?url=x')).status,405);
});
test('default opener refuses active content before invoking a process',async()=>{
  const call=host();await login(call);mock=()=>response('<html>fixture</html>',200,{'content-type':'text/html'});
  const r=await call('openAttachment',{url:'http://zentao.test/zentao/file-read-1.pdf',name:'fixture.pdf'});
  assert.equal(r.json.error.code,'forbidden');assert.equal(opens,0);
  for(const ext of ['exe','svg','docm','xlsm']){
    requests=[];const rejected=await call('openAttachment',{url:'http://zentao.test/zentao/file-read-1.'+ext});
    assert.equal(rejected.json.error.code,'forbidden');assert.equal(requests.length,0);
  }
});
test('declared oversize is cancelled without reading body',async()=>{
  const call=host();await login(call);let cancelled=false;
  mock=()=>({ok:true,status:200,headers:new Headers({'content-length':String(65*1024*1024)}),body:{cancel(){cancelled=true;},getReader(){throw Error('Must not read');}}});
  assert.equal((await attachment(call)).status,413);assert.equal(cancelled,true);
});
test('normal Office MIME is not mistaken for active XML and filenames lose shell metacharacters',async()=>{
  const call=host();await login(call);
  mock=()=>response(new Uint8Array([80,75,3,4]),200,{'content-type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
  const r=await call('openAttachment',{url:'http://zentao.test/zentao/file-read-1.docx',name:'fixture&%PATH%!.docx'});
  assert.equal(r.json.ok,true);assert.equal(r.json.value.opened,true);assert.equal(opens,1);
  assert.ok(!/[&%!]/.test(r.json.value.savedPath));
});
test('chunked oversize stops early and cancels the stream',async()=>{
  const call=host();await login(call);let cancelled=false,reads=0;
  const chunk=new Uint8Array(1024*1024);
  mock=()=>({ok:true,status:200,headers:new Headers(),body:{getReader(){return{async read(){reads++;return{done:false,value:chunk};},async cancel(){cancelled=true;},releaseLock(){}};}}});
  assert.equal((await attachment(call)).status,413);assert.equal(reads,65);assert.equal(cancelled,true);
});
test('stream failures return error envelope and release concurrency slot',async()=>{
  const call=host();await login(call);
  mock=()=>new Response(new ReadableStream({start(c){c.error(Error('fixture stream failure'));}}));
  for(let i=0;i<5;i++)assert.equal((await attachment(call)).status,502);
});
test('download concurrency limit rejects fifth and recovers after completion',async()=>{
  const call=host();await login(call);const release=deferred();let started=0;
  mock=async()=>{started++;await release.promise;return response('fixture',200,{'content-type':'image/png'});};
  const pending=Array.from({length:4},()=>attachment(call));
  while(started<4)await new Promise(r=>setImmediate(r));
  assert.equal((await attachment(call)).status,429);release.resolve();await Promise.all(pending);
  assert.equal((await attachment(call)).status,200);
});
function taskMock({after,writeError=false,readError=false,writeStatus=200}){
  let written=false,writes=0;
  mock=(url,init)=>{
    if(/\/tasks\/1\/(start|finish)$/.test(url)){written=true;writes++;if(writeError)throw Error('fixture disconnected');return response('',writeStatus);}
    if(url.endsWith('/tasks/1')){if(written&&readError)throw Error('fixture read failed');return response({task:written?after:{id:1,status:'wait',consumed:3,left:7}});}
    return standard(url,init);
  };
  return()=>writes;
}
for(const action of ['start','finish'])test(action+' verifies exact target status and hours',async()=>{
  const call=host();await login(call);
  taskMock({after:{id:1,status:action==='start'?'doing':'done',consumed:action==='start'?3:5,left:action==='start'?7:0}});
  const r=(await call(action+'Task',{id:'1',hours:2})).json.value;
  assert.equal(r.succeeded,true);assert.equal(r.outcome,'succeeded');assert.equal(r.hoursVerified,true);
});
test('unexpected status is partial, not success',async()=>{
  const call=host();await login(call);taskMock({after:{id:1,status:'pause',consumed:5,left:0}});
  const r=(await call('finishTask',{id:'1',hours:2})).json.value;
  assert.equal(r.changed,false);assert.equal(r.outcome,'partial');assert.equal(r.status,'pause');
});
test('target status with missing/wrong hours is not success',async()=>{
  const call=host();await login(call);
  for(const consumed of [3,undefined]){
    taskMock({after:{id:1,status:'done',consumed,left:0}});
    const r=(await call('finishTask',{id:'1',hours:2})).json.value;
    assert.equal(r.changed,false);assert.equal(r.hoursVerified,false);assert.notEqual(r.outcome,'succeeded');
  }
});
test('start verifies preserved left hours',async()=>{
  const call=host();await login(call);taskMock({after:{id:1,status:'doing',consumed:3,left:0}});
  const r=(await call('startTask',{id:'1'})).json.value;assert.equal(r.changed,false);assert.equal(r.hoursVerified,false);
});
test('failed readback yields uncertain result and never repeats write',async()=>{
  const call=host();await login(call);const writes=taskMock({readError:true});
  const r=(await call('finishTask',{id:'1',hours:2})).json.value;
  assert.equal(r.outcome,'uncertain');assert.equal(r.changed,false);assert.equal(writes(),1);
});
test('lost write response yields uncertain result even if target fields read back',async()=>{
  const call=host();await login(call);const writes=taskMock({writeError:true,after:{id:1,status:'done',consumed:5,left:0}});
  const r=(await call('finishTask',{id:'1',hours:2})).json.value;
  assert.equal(r.outcome,'uncertain');assert.equal(r.changed,false);assert.equal(writes(),1);
});
test('mutation 401 is never automatically replayed',async()=>{
  const call=host();await login(call,{token:'',password:'fixture-secret',rememberPassword:true});
  const writes=taskMock({writeStatus:401});const r=await call('finishTask',{id:'1',hours:2});
  assert.equal(r.json.error.code,'unauthorized');assert.equal(writes(),1);
});
test('concurrent task mutations are rejected before duplicate writes',async()=>{
  const call=host();await login(call);const entered=deferred(),release=deferred();let written=false,writes=0;
  mock=async(url,init)=>{
    if(url.endsWith('/finish')){written=true;writes++;entered.resolve();await release.promise;return response('');}
    if(url.endsWith('/tasks/1'))return response({task:{id:1,status:written?'done':'wait',consumed:written?5:3,left:7}});
    return standard(url,init);
  };
  const first=call('finishTask',{id:'1',hours:2});await entered.promise;
  assert.equal((await call('finishTask',{id:'1',hours:2})).json.error.code,'busy');
  release.resolve();await first;assert.equal(writes,1);
});
test('logout while parallel refresh fails does not leave an unhandled rejection',async()=>{
  const call=host();await login(call);const entered=deferred(),release=deferred();let failures=0;
  const onUnhandled=()=>failures++;
  process.on('unhandledRejection',onUnhandled);
  mock=async(url,init)=>{
    if(url.includes('/tasks?')||url.includes('/products?')){entered.resolve();await release.promise;throw Error('fixture cancelled');}
    return standard(url,init);
  };
  try {
    const work=call('refresh',{scope:'bugs'});await entered.promise;await call('logout');release.resolve();await work;
    await new Promise(r=>setImmediate(r));assert.equal(failures,0);assert.equal((await getConfig(call)).hasToken,false);
  } finally {process.off('unhandledRejection',onUnhandled);}
});
let passed=0;
try {
  for(const {name,fn} of tests){requests=[];opens=0;mock=standard;await fn();passed++;console.log('PASS '+name);}
  console.log('SECURITY REGRESSION '+passed+'/'+tests.length+' PASS');
} finally {
  cp.spawn=originals.spawn;cp.spawnSync=originals.spawnSync;globalThis.fetch=originals.fetch;syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', platformDescriptor);
  rmSync(temp,{recursive:true,force:true});
}
