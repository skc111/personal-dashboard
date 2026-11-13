const {chromium}=require(process.env.DASHBOARD_TEST_PLAYWRIGHT || 'playwright');const assert=require('node:assert/strict');
const {startTestServer}=require('./browser-server.cjs');
(async()=>{
 const fixture=await startTestServer();
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']}).catch(async error=>{await fixture.close();throw error;});const files=new Map();let etag=0,network=true;const pages=[],contexts=[],exports=[];
 async function device(){
  const c=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});contexts.push(c);let config={enabled:false,email:'',folder:'personal-dashboard-v1',hasPassword:false};
  await c.exposeBinding('mockNativeRPC',async(source,id,request)=>{
   const{action,args}=JSON.parse(request);
   try{let value;
    if(action==='configGet')value=config;
    else if(action==='configSave'){config={...config,...args,hasPassword:true};delete config.password;value=config;}
    else if(action==='export'){exports.push(JSON.parse(args.text));value=true;}
    else if(action==='dav'){
     if(!network)throw Error('模拟断网');
     if(args.op==='mkdir')value={};
     else if(args.op==='list')value=[...files].map(([name,v])=>({name,etag:v.etag}));
     else if(args.op==='get'){const f=files.get(args.name);if(!f)throw Error('404');value=f;}
     else if(args.op==='put'){value={etag:'e'+ ++etag};files.set(args.name,{body:args.body,etag:value.etag});}
    }
    await source.page.evaluate(({id,value})=>window.dashboardNativeReply(id,{ok:true,value}),{id,value});
   }catch(e){await source.page.evaluate(({id,message})=>window.dashboardNativeReply(id,{ok:false,error:message}),{id,message:e.message});}
  });
  await c.addInitScript(()=>{window.DashboardNative={
   readLocal(){return JSON.stringify({ok:true,value:JSON.parse(localStorage.getItem('native-state')||'null')});},
   writeLocal(value){localStorage.setItem('native-state',value);return JSON.stringify({ok:true,value:true});},
   request(id,request){window.mockNativeRPC(id,request);}
  };});
  const p=await c.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));p.errors=errors;
  await p.route('**/api/**',r=>{throw Error('Native mode must not call desktop API: '+r.request().url());});
  await p.goto(fixture.url);await p.waitForFunction(()=>syncClient?.ready);await p.evaluate(()=>{clearInterval(syncClient.timer);});pages.push(p);return p;
 }
 async function tick(p){await p.waitForFunction(()=>!syncClient.running);await p.evaluate(()=>syncClient.tick(true));}
 async function edit(p,fn){await p.evaluate(fn);await p.waitForFunction(()=>syncClient.localWrites===0);}
 try{
  const a=await device(),b=await device();
  assert.equal(await a.evaluate(()=>state.db.todos.length),0);
  await edit(a,async()=>{state.db.todos.push({id:'legacy',title:'保留的旧日程',date:todayISO(),done:false});state.db.deadlines.push({id:'due',title:'原截止事项',date:todayISO(),time:'23:59',done:false});state.db.trips.push({id:'trip',city:'杭州',startDate:todayISO()});state.db.transactions.push({id:'meal',type:'expense',amount:28,category:'餐饮',tripId:'trip',date:todayISO(),note:'午饭'});await save();});
  await a.evaluate(()=>syncClient.configure({enabled:true,email:'fake@example.invalid',password:'not-real',folder:'personal-dashboard-v1'}));
  await b.evaluate(()=>syncClient.configure({enabled:true,email:'fake@example.invalid',password:'not-real',folder:'personal-dashboard-v1'}));await tick(a);
  assert.equal(await b.evaluate(()=>state.db.deadlines[0].title),'原截止事项');assert.equal(await b.evaluate(()=>state.db.transactions[0].tripId),'trip');
  // Both devices offline: distinct inserts and competing edits to the same ID.
  network=false;
  await edit(a,async()=>{state.db.deadlines[0].title='手机改截止事项';state.db.transactions.push({id:'a-expense',type:'expense',amount:6,category:'餐饮',date:todayISO()});await save();});
  await edit(b,async()=>{state.db.deadlines[0].title='电脑改截止事项';state.db.transactions.push({id:'b-expense',type:'expense',amount:8,category:'交通',date:todayISO()});await save();});
  await tick(a);assert(await a.evaluate(()=>!!syncClient.cloudError));
  await a.reload();await a.waitForFunction(()=>syncClient?.ready);await a.evaluate(()=>clearInterval(syncClient.timer));assert.equal(await a.evaluate(()=>state.db.deadlines[0].title),'手机改截止事项');
  network=true;await tick(a);await tick(b);await tick(a);await tick(b);
  for(const p of[a,b]){assert.equal(await p.evaluate(()=>state.db.transactions.length),3);assert.equal(await p.evaluate(()=>DashboardSyncCore.conflicts(syncClient.doc).length),1);}
  // Resolve conflict, then sync a deletion. A stale cloud snapshot cannot revive it.
  await a.evaluate(async()=>{const c=DashboardSyncCore.conflicts(syncClient.doc)[0];await syncClient.resolve(c.key,{context:syncClient.doc.records[c.key],value:c.versions.find(v=>v.value.title==='手机改截止事项').value});});
  await tick(a);await tick(b);await tick(a);assert.equal(await b.evaluate(()=>DashboardSyncCore.conflicts(syncClient.doc).length),0);
  const old=[...files.values()].map(x=>({...x}));
  await edit(b,async()=>{state.db.transactions=state.db.transactions.filter(t=>t.id!=='meal');await save();});await tick(b);await tick(a);
  files.set('device-ffffffffffffffffffffffffffffffff.json',{body:old[0].body,etag:'stale'});await tick(a);await tick(b);
  assert.equal(await a.evaluate(()=>state.db.transactions.some(t=>t.id==='meal')),false);
  // Remote update while an editor is open: field untouched, installed on close.
  await a.locator('.hero [data-modal="deadline"]').click();await a.locator('#ddlTitle').fill('未保存的编辑框');
  await edit(b,async()=>{state.db.deadlines.push({id:'remote-new',title:'另一端新增',date:todayISO(),time:'10:00',done:false});await save();});await tick(b);await tick(a);
  assert.equal(await a.locator('#ddlTitle').inputValue(),'未保存的编辑框');await a.locator('#modalClose').click();await a.waitForFunction(()=>state.db.deadlines.some(t=>t.id==='remote-new'));
  // Daily review draft is not replaced by a remote update or navigating away.
  await a.locator('#bottomNav [data-view="review"]').click();await a.locator('#reviewOutput').fill('今天的回顾草稿\n第二行');
  await edit(b,async()=>{state.db.transactions.push({id:'after-review',type:'expense',amount:9,category:'餐饮',date:todayISO()});await save();});await tick(b);await tick(a);
  assert.equal(await a.locator('#reviewOutput').inputValue(),'今天的回顾草稿\n第二行');
  await a.locator('#bottomNav [data-view="finance"]').click();await a.locator('#bottomNav [data-view="review"]').click();assert.equal(await a.locator('#reviewOutput').inputValue(),'今天的回顾草稿\n第二行');
  await a.locator('#reviewSaveBtn').click();await a.waitForFunction(()=>syncClient.localWrites===0);await tick(a);await tick(b);
  assert.equal(await b.evaluate(()=>state.db.reviews[todayISO()]),'今天的回顾草稿\n第二行');
  await a.evaluate(()=>exportFullBackup());assert(exports.at(-1)._sync);assert(!JSON.stringify(exports.at(-1)).includes('not-real'));assert.equal(files.size,3);
  // Truncated remote JSON must cause an error, preserving all local records.
  const count=await a.evaluate(()=>state.db.todos.length);files.set('device-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.json',{body:'{bad',etag:'bad'});await tick(a);assert(await a.evaluate(()=>!!syncClient.cloudError));assert.equal(await a.evaluate(()=>state.db.todos.length),count);
  for(const p of pages){assert.deepEqual(p.errors,[]);assert.equal(await p.locator('[data-view="schedule"],[data-modal="todo"]').count(),0);assert.equal(await p.evaluate(()=>state.db.todos.length),1);assert.equal(await p.evaluate(()=>state.db.todos[0].title),'保留的旧日程');}
  console.log('PASS simulated Android bridge: independent offline stores, bidirectional DAV snapshots, restart, concurrent conflicts, explicit resolution, tombstones, stale snapshots, open form/review drafts, secret-free export, malformed remote protection, hidden legacy schedule preservation');
 }finally{for(const c of contexts)await c.close();await browser.close();await fixture.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
