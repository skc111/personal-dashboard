// Dense synthetic fixtures only. This suite never connects to the user's server.
const {chromium}=require(process.env.DASHBOARD_TEST_PLAYWRIGHT || 'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {startTestServer}=require('./browser-server.cjs');
const wait=p=>p.waitForTimeout(100);
async function bounds(page,label){
  const result=await page.evaluate(()=>({layout:innerWidth,document:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
  // innerWidth alone misses mobile overflow: Chromium expands the layout viewport!
  assert(result.layout<=page.viewportSize().width+1,`${label}: enlarged layout viewport ${JSON.stringify(result)}`);
  assert(result.document<=result.client+1,`${label}: horizontal page overflow ${JSON.stringify(result)}`);
}
async function sheetBounds(page,label){
  await page.locator(".modal").evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
  await wait(page);await bounds(page,label);
  const r=await page.evaluate(()=>{
    const body=document.querySelector('#modalBody'),head=document.querySelector('.modal-head');
    const b=body.getBoundingClientRect(),h=head.getBoundingClientRect(),m=document.querySelector('.modal').getBoundingClientRect();
    const visible=window.visualViewport;
    return {top:m.top,bottom:m.bottom,bodyTop:b.top,headBottom:h.bottom,width:body.clientWidth,scrollWidth:body.scrollWidth,height:visible?.height||innerHeight,close:document.querySelector('#modalClose').getBoundingClientRect().bottom};
  });
  assert(r.top>=-1&&r.bottom<=r.height+1,`${label}: sheet outside visible viewport ${JSON.stringify(r)}`);
  assert(r.bodyTop>=r.headBottom-1,`${label}: heading overlaps form`);
  assert(r.scrollWidth<=r.width+1,`${label}: form horizontal overflow`);
  assert(r.close<=r.height,`${label}: close button unreachable`);
}
async function swipe(page){
  const r=await page.locator('#modalBody').boundingBox();
  const session=await page.context().newCDPSession(page);
  const x=r.x+r.width-8,from=r.y+r.height-70,to=r.y+55;
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:from}]});
  for(let i=1;i<=12;i++){
    await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:from+(to-from)*i/12}]});
    await page.waitForTimeout(20);
  }
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await session.detach();await page.waitForTimeout(200);
}
async function seed(page){
  await page.evaluate(async()=>{
    const ym=todayISO().slice(0,7),[y,m]=ym.split('-').map(Number),days=new Date(y,m,0).getDate();
    const long='布局测试：很长的标题与备注需要自然换行，不能挤压右侧操作按钮。';
    for(let d=1;d<=days;d++)for(let i=0;i<15;i++)state.db.todos.push({id:`layout-${d}-${i}`,date:`${ym}-${String(d).padStart(2,'0')}`,title:'旧日程保留-'+i,start:`${String(i+6).padStart(2,'0')}:00`,end:`${String(i+6).padStart(2,'0')}:30`,priority:'normal',done:i<12,note:'SYNTHETIC_LONG_TEXT_'.repeat(12)});
    state.db.subjects.push({id:'layout-subject',name:long,teacher:'示例教师 / 3 学分',exam:long.repeat(5),notes:long,points:Array.from({length:12},(_,i)=>({id:`layout-point-${i}`,title:long,date:todayISO(),detail:('测试段落\n').repeat(5)})),questions:[{id:'layout-question',text:long,answer:long,done:false,date:todayISO()}],materials:[{id:'layout-material',title:long,url:'https://example.com/material'}]});
    state.db.trips.push({id:'layout-trip',city:'虚构城市旅行账本测试'.repeat(3),startDate:todayISO(),endDate:todayISO(),note:long});
    for(let i=0;i<10;i++)state.db.transactions.push({id:`layout-trans-${i}`,date:todayISO(),type:i===9?'income':'expense',amount:12345.67,category:i===9?'工资':'餐饮',note:long,tripId:i%2?'layout-trip':''});
    state.db.deadlines.push({id:'layout-ddl',title:long,date:todayISO(),time:'23:59',note:long.repeat(3),done:false});
    await save();render();
  });
  await page.waitForFunction(()=>syncClient.localWrites===0&&!syncClient.localRunning);
}
(async()=>{
  const fixture=await startTestServer();
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']}).catch(async e=>{await fixture.close();throw e});
  try{
    let seeded=false;
    for(const [width,height] of [[320,640],[360,740],[390,844],[412,915],[740,360],[1366,900]]){
      const mobile=width<=860,context=await browser.newContext({viewport:{width,height},isMobile:mobile,hasTouch:mobile});
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(fixture.url);await page.waitForFunction(()=>syncClient?.ready);
      if(!seeded){await seed(page);seeded=true;}else await page.waitForFunction(()=>state.db.todos.some(t=>t.id==='layout-1-0'));
      const initial=await page.evaluate(()=>JSON.stringify(state.db));
      assert.equal(await page.locator('[data-view="schedule"],#view-schedule,[data-modal="todo"],#dashTodos').count(),0);
      if(mobile){
        assert.deepEqual(await page.locator('#bottomNav button>span:last-child').allTextContents(),['今日','课程','记账','DDL','回顾']);
        assert.equal(await page.locator('#bottomNav .active').getAttribute('data-view'),'dashboard');
        const nav=await page.evaluate(()=>{const b=document.querySelector('#bottomNav').getBoundingClientRect();return {bottom:b.bottom,last:Math.max(...[...document.querySelectorAll('#bottomNav button>span:last-child')].map(s=>s.getBoundingClientRect().bottom))}});
        assert(nav.bottom<=height+1&&nav.last<=height-5,'bottom labels cut off');
      }
      for(const theme of ['light','dark']){
        await page.evaluate(theme=>applyTheme(theme),theme);
        for(const view of ['dashboard','course','finance','deadline','review']){
          await page.locator(`${mobile?'#bottomNav':'#nav'} [data-view=${view}]`).click();await wait(page);await bounds(page,`${width}/${theme}/${view}`);
          if(mobile){
            await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));await wait(page);
            const bottom=await page.locator('.view.active').evaluate(el=>el.getBoundingClientRect().bottom);
            const navTop=await page.locator('#bottomNav').evaluate(el=>el.getBoundingClientRect().top);
            assert(bottom<=navTop-8,`${view}: last content hidden behind nav`);
          }
          if(process.env.MOBILE_SCREENSHOTS && width===390 && theme==='light'){
            fs.mkdirSync(process.env.MOBILE_SCREENSHOTS,{recursive:true});await page.evaluate(()=>window.scrollTo(0,0));await wait(page);await page.screenshot({path:path.join(process.env.MOBILE_SCREENSHOTS,`${view}.png`)});
          }
        }
      }
      await page.evaluate(()=>applyTheme('light'));
      for(const type of ['trans','course','deadline','trip','settings']){
        await page.evaluate(type=>openModal(type),type);await sheetBounds(page,`${width}/${type}`);
        if(mobile)assert.equal(await page.evaluate(()=>document.activeElement.id),'modalClose','entry must not automatically summon keyboard');
        else if(type==='trans')assert.equal(await page.evaluate(()=>document.activeElement.id),'transAmount','desktop accounting should focus the amount');
        if(type==='trans'&&mobile){
          await page.setViewportSize({width,height:Math.min(height,560)});await wait(page);
          await page.locator('#modalBody').evaluate(el=>el.scrollTop=0);
          const before=await page.locator('#modalBody').evaluate(el=>el.scrollTop);
          await swipe(page);
          assert(await page.locator('#modalBody').evaluate(el=>el.scrollTop)>before+30,'touch gesture cannot scroll the form');
          assert.equal(await page.evaluate(()=>window.scrollY),0,'background page scrolled instead of form');
          await page.locator('#transNote').fill('测试备注第一行\n第二行');
          await page.setViewportSize({width,height:Math.min(height,380)});await sheetBounds(page,`${width}/keyboard`);
          await page.locator('#transForm [type=submit]').scrollIntoViewIfNeeded();
          const save=await page.locator('#transForm [type=submit]').boundingBox();assert(save.y+save.height<=page.viewportSize().height+1,'save hidden by simulated keyboard');
          await page.setViewportSize({width,height});
          if(process.env.MOBILE_SCREENSHOTS && width===390)await page.screenshot({path:path.join(process.env.MOBILE_SCREENSHOTS,'finance-form.png')});
        }
        await page.locator('#modalClose').click();assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('modal-open')),false,'scroll lock remains after close');
      }
      // Course sub-tabs and sync help can be considerably longer than the basic forms.
      for(const tab of ['points','questions','materials','exam']){
        await page.evaluate(tab=>{state.subjectTab=tab;openWideModal('测试课程',subjectDetailHTML(subjById('layout-subject')))},tab);
        await sheetBounds(page,`${width}/subject-${tab}`);await page.locator('#modalClose').click();
      }
      await page.locator('#syncBadge').click();await page.locator('#syncEmail').waitFor({state:'visible'});
      for(const el of await page.locator('.sync-help summary').all())await el.click();
      await sheetBounds(page,`${width}/sync-help`);await page.locator('#modalClose').click();
      // Large text: preserve readable labels, permit tab-strip scrolling, never page overflow.
      if(mobile){
        const style=await page.addStyleTag({content:'body {font-size:19px} .tabs button,.segmented button {font-size:18px} .bottom-nav button {font-size:16px}'});
        for(const v of ['course','finance','deadline','review']){await page.evaluate(v=>switchView(v),v);await wait(page);await bounds(page,`${width}/large-text/${v}`);}
        await page.evaluate(()=>openModal('deadline'));await sheetBounds(page,`${width}/large-text/modal`);await page.locator('#modalClose').click();await style.evaluate(el=>el.remove());
      }
      assert.equal(await page.evaluate(()=>JSON.stringify(state.db)),initial,'layout interactions changed saved records');
      if(width===320){
        // Real save/reload on a phone-sized page; do not rely only on layout reads.
        await page.evaluate(()=>switchView('dashboard'));
        await page.locator('.hero [data-modal=deadline]').click();
        await page.locator('#ddlTitle').fill('虚构移动端保存验证');
        await page.locator('#ddlTimeH').fill('8');await page.locator('#ddlTimeM').fill('15');
        await page.locator('#ddlNote').fill('备注第一行\n第二行不会触发保存');
        await page.locator('#deadlineForm [type=submit]').click();
        await page.waitForFunction(()=>document.querySelector('#modalOverlay').hidden&&syncClient.localWrites===0&&!syncClient.localRunning);
        await page.reload();await page.waitForFunction(()=>syncClient?.ready);
        assert.equal(await page.evaluate(()=>state.db.deadlines.filter(t=>t.title==='虚构移动端保存验证'&&t.time==='08:15'&&t.note.includes('\n')).length),1);
        // Restore this isolated fixture for the remaining size profiles.
        await page.evaluate(async()=>{state.db.deadlines=state.db.deadlines.filter(t=>t.title!=='虚构移动端保存验证');await save();});
        await page.waitForFunction(()=>syncClient.localWrites===0&&!syncClient.localRunning);
      }
      assert.deepEqual(errors,[]);console.log(`PASS ${width}×${height}: populated pages, hidden legacy schedules, five-tab navigation, forms, course tabs, sync settings${mobile?', touch swipe, keyboard-size viewport, enlarged text':''}`);
      await context.close();
    }
  }finally{await browser.close();await fixture.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
