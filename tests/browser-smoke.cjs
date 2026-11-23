const {chromium}=require(process.env.DASHBOARD_TEST_PLAYWRIGHT || 'playwright');
const assert=require('node:assert/strict');
const {startTestServer}=require('./browser-server.cjs');
(async()=>{
 const fixture=await startTestServer();
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']}).catch(async error=>{await fixture.close();throw error;});
 try{
  const context=await browser.newContext({viewport:{width:1380,height:950}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(fixture.url);await page.waitForFunction(()=>typeof syncClient!=='undefined'&&syncClient?.ready);
  const before=await page.evaluate(()=>({todos:state.db.todos.length,transactions:state.db.transactions.length,subjects:state.db.subjects.length}));
  assert.equal(before.todos,0);assert.equal(before.transactions,0);assert.equal(before.subjects,0);
  // A UI removal must never delete hidden historical data or its sync versions.
  const legacyReview = { '2021-10-02': '归档的示例回顾\n保留第二行' };
  await page.evaluate(async reviews => {
    state.db.todos.push({id:'legacy-schedule',title:'旧日程只保留数据',date:todayISO(),start:'07:30',end:'08:00',done:false,note:'归档备注',repeat:'每周',seriesId:'legacy-series'});
    Object.assign(state.db.reviews, reviews);
    await save();
  }, legacyReview);
  const legacy=await page.evaluate(()=>JSON.stringify(state.db.todos));
  assert.equal(await page.locator('[data-view="schedule"],#view-schedule,[data-modal="todo"],#dashTodos').count(),0);
  assert.equal(await page.locator('[data-view="review"],#view-review').count(),0);
  assert.equal(await page.locator('#bottomNav button').count(),5);
  assert(!await page.locator('#view-dashboard').textContent().then(s=>s.includes('旧日程只保留数据')));
  await page.locator('.hero [data-modal="deadline"]').click();await page.locator('#ddlTitle').fill('同步测试-DDL');await page.locator('#ddlTimeH').fill('7');await page.locator('#ddlTimeM').fill('30');await page.locator('#ddlNote').fill('第一行\n第二行');
  const deadlineEditor = page.locator('#deadlineForm');
  await page.locator('#modalOverlay').click({position:{x:4,y:4}});
  assert(await deadlineEditor.isVisible(),'clicking the backdrop must keep the DDL editor open');
  assert.equal(await deadlineEditor.locator('#ddlTitle').inputValue(),'同步测试-DDL');
  await page.locator('#deadlineForm [type=submit]').click();
  await page.waitForFunction(()=>state.db.deadlines.some(t=>t.title==='同步测试-DDL')&&syncClient.localWrites===0&&!syncClient.localRunning);
  await page.reload();await page.waitForFunction(()=>syncClient?.ready&&state.db.deadlines.some(t=>t.title==='同步测试-DDL'));
  assert.equal(await page.evaluate(()=>JSON.stringify(state.db.todos)),legacy);
  assert.deepEqual(await page.evaluate(()=>state.db.reviews),legacyReview);
  for (const removed of ['review','schedule']) {
    await page.evaluate(view=>{switchView('finance');switchView(view);},removed);
    assert.equal(await page.evaluate(()=>state.view),'dashboard','removed route must fall back safely');
  }

  // Annual reporting uses calendar-year boundaries and includes travel exactly once.
  const reportYear = await page.evaluate(() => String(Number(todayISO().slice(0, 4)) - 1));
  await page.locator('#nav [data-view=finance]').click();
  await page.locator('[data-finance-period=year]').click();
  assert.match(await page.locator('#financeAnnual').textContent(), /这一年还没有收支记录/);
  await page.evaluate(async year => {
    const beforeYear = Number(year) - 1, nextYear = Number(year) + 1;
    state.db.trips.push({id:'annual-trip',city:'示例城市',startDate:`${year}-01-01`,endDate:`${year}-01-01`});
    state.db.transactions.push(
      {id:'year-before',date:`${beforeYear}-12-31`,type:'expense',amount:900,category:'其他'},
      {id:'year-main',date:`${year}-01-01`,type:'expense',amount:12.34,category:'餐饮'},
      {id:'year-travel',date:`${year}-01-01`,type:'expense',amount:50,category:'交通',tripId:'annual-trip'},
      {id:'year-income',date:`${year}-12-31`,type:'income',amount:125,category:'其他'},
      {id:'year-after',date:`${nextYear}-01-01`,type:'income',amount:500,category:'其他'}
    );
    await save();
    renderFinance();
  }, reportYear);
  await page.locator('#financeYear').selectOption(reportYear);
  assert.deepEqual(await page.locator('.annual-totals .value').allTextContents(), ['¥62.34', '¥125.00']);
  assert.deepEqual(await page.locator('.annual-split span').allTextContents(), ['主账本 ¥12.34', '旅行 ¥50.00']);
  const months = page.locator('.annual-months tbody tr');
  assert.equal(await months.count(), 12);
  assert.deepEqual(await months.first().locator('td span').allTextContents(), ['¥62.34', '—']);
  assert.deepEqual(await months.last().locator('td span').allTextContents(), ['—', '¥125.00']);
  await months.first().getByRole('button').click();
  assert.equal(await page.locator('#financeMonth').inputValue(), reportYear + '-01');
  assert.equal(await page.locator('#transList .transaction-item').count(), 2);
  await page.locator('[data-finance-period=year]').click();
  assert.equal(await page.locator('#financeYear').inputValue(), reportYear);
  await page.locator('[data-finance-period=month]').click();

  await page.locator('#syncBadge').click();await page.locator('#syncEmail').waitFor({state:'visible'});assert(await page.locator('#syncFolder').inputValue()==='personal-dashboard-v1');await page.locator('#modalClose').click();
  const tab=await context.newPage();await tab.goto(fixture.url);await tab.waitForFunction(()=>syncClient?.ready);
  await Promise.all([page.evaluate(async()=>{state.db.transactions.push({id:'browser-a',type:'expense',date:todayISO(),amount:11,category:'餐饮',note:'并发 A'});await save();}),tab.evaluate(async()=>{state.db.deadlines.push({id:'browser-b',title:'并发 B',date:todayISO(),time:'09:00',done:false});await save();})]);
  // flushDesktop deliberately skips an already-running flush. Wait for each
  // background save before requesting another pass, then test convergence.
  for(const p of [page,tab,page]){
   await p.waitForFunction(()=>!syncClient.localRunning&&syncClient.localWrites===0);
   await p.evaluate(()=>syncClient.flushDesktop());
  }
  assert(await page.evaluate(()=>DashboardSyncCore.materialize(syncClient.doc).transactions.some(t=>t.id==='browser-a')&&DashboardSyncCore.materialize(syncClient.doc).deadlines.some(t=>t.id==='browser-b')));
  const saved=await(await page.request.get(fixture.url+'/api/data')).json();
  assert(saved.transactions.some(t=>t.id==='browser-a')&&saved.deadlines.some(t=>t.id==='browser-b'));
  assert.deepEqual(saved.reviews,legacyReview);
  await tab.close();
  await page.route('**/api/**',r=>r.abort());
  await page.evaluate(async()=>{state.db.transactions.push({id:'offline-test',type:'expense',date:todayISO(),amount:12,category:'餐饮',note:'离线保存'});await save();});
  // An IndexedDB-only save must not look as safe as a confirmed disk/cloud save.
  assert(await page.evaluate(()=>syncClient.needsExitWarning()));
  await page.locator('#saveBanner').waitFor({state:'visible'});
  assert.match(await page.locator('#saveBanner').textContent(),/仅保存在当前浏览器/);
  const [emergency]=await Promise.all([page.waitForEvent('download'),page.locator('#saveBanner button').click()]);
  const emergencyData=JSON.parse(require('node:fs').readFileSync(await emergency.path(),'utf8'));
  assert(emergencyData.transactions.some(t=>t.id==='offline-test'),'emergency export must include the unconfirmed edit');
  assert(emergencyData._sync,'emergency export must preserve merge metadata');
  assert.equal(JSON.stringify(emergencyData.todos),legacy,'full export must retain historical schedules');
  assert.deepEqual(emergencyData.reviews,legacyReview,'full export must retain historical reviews');
  let warned=false;
  page.once('dialog',async dialog=>{assert.equal(dialog.type(),'beforeunload');warned=true;await dialog.accept();});
  await page.reload();await page.waitForFunction(()=>syncClient?.ready&&state.db.transactions.some(t=>t.id==='offline-test'));
  assert(warned,'closing/reloading an unconfirmed offline edit must warn');
  assert(await page.evaluate(()=>syncClient.needsExitWarning()));
  await page.unroute('**/api/**');await page.evaluate(()=>syncClient.flushDesktop());
  await page.waitForFunction(()=>!syncClient.localRunning&&syncClient.localWrites===0&&!syncClient.needsExitWarning());
  assert(await page.locator('#saveBanner').isHidden(),'warning should clear after disk confirmation');
  // A current cloud acknowledgement is also a durable copy, even if disk is offline.
  await page.evaluate(()=>{const old=syncClient.serverBody;syncClient.serverBody='';syncClient.ownConfirmed=DashboardSyncCore.stable(syncClient.doc);window.testConfirmedCloud=syncClient.needsExitWarning();syncClient.serverBody=old;});
  assert.equal(await page.evaluate(()=>window.testConfirmedCloud),false);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:require('node:path').join(fixture.dir,'home.png'),fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false);
  for(const view of ['course','finance','deadline','moments']){await page.locator(`#bottomNav [data-view="${view}"]`).click();await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'overflow in '+view);}
  await page.locator('#syncBadge').click();await page.screenshot({path:require('node:path').join(fixture.dir,'sync.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>JSON.stringify(state.db.todos)),legacy);
  assert.deepEqual(errors,[]);console.log('PASS five views, DDL and finance, legacy schedule/review preservation, multitab, offline reload and exports');
  await context.close();
 }finally{await browser.close();await fixture.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
