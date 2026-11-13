/* Minimal, shared desktop / phone sync settings. No passwords in the page URL. */
let syncClient=null, syncUIStatus=null, remoteRefreshPending=false;
function renderSyncStatus(info) {
  syncUIStatus=info;
  const side=document.getElementById('saveStatus');if(side)side.textContent=info.text;
  const badge=document.getElementById('syncBadge');
  if(badge){badge.textContent=info.conflicts?'需要核对':info.error?'待同步':info.running?'同步中':!info.enabled?'仅本地':info.text.includes('等待')?'待同步':'已同步';badge.title=info.text;badge.dataset.warn=!!(info.error||info.conflicts);}
  const detail=document.getElementById('syncDetailStatus');if(detail)detail.textContent=info.text+(info.error?'\n'+info.error:'');
  const conflict=document.getElementById('syncConflictBtn');if(conflict){conflict.textContent=`核对冲突（${info.conflicts}）`;conflict.hidden=!info.conflicts;}
  if(info.error&&syncClient?.localError)saveBanner(true,'本地保存失败：'+info.error+'。请不要关闭页面，立即在同步设置中导出备份。','local-error');
  else if(info.browserOnly&&syncClient?.desktopError)saveBanner(true,'最近修改仅保存在当前浏览器，尚未写入电脑或云端。请保留本页，并在同步设置中导出完整备份；清理浏览器数据可能丢失这些修改。','browser-only');
  else {
    const banner=document.getElementById('saveBanner');
    if(banner&&['local-error','browser-only'].includes(banner.dataset.reason))saveBanner(false);
  }
}
function reviewHasDraft() {
  return typeof reviewDirty!=='undefined' && reviewDirty;
}
function applyRemoteUpdates() {
  if(!syncClient?.ready||!state.db)return;
  remoteRefreshPending=true;
  // Never replace an open editor or a daily-review draft in response to polling.
  if(!document.getElementById('modalOverlay').hidden||reviewHasDraft())return;
  if(DashboardSyncCore.equal(syncClient.doc,syncClient.viewDoc)){remoteRefreshPending=false;return;}
  state.db=syncClient.takeView();applyTheme(state.db.settings.theme);render();remoteRefreshPending=false;
}
async function exportFullBackup() {
  if(!syncClient)return;
  await DashboardSync.download(`个人面板备份-${todayISO()}.json`,JSON.stringify(syncClient.exportData(),null,2));
}
async function openSyncPanel() {
  if(!syncClient?.ready)return;
  let c;
  try{c=await DashboardSync.rpc('configGet');}catch(e){toast(e.message);return;}
  openWideModal('多设备同步',`
    <div class="sync-intro"><strong>电脑与手机，共用一本记录</strong><p class="muted">先保存在本地，打开时自动同步；断网也能继续记。电脑关机不影响手机。</p></div>
    <div class="sync-status-box" id="syncDetailStatus" role="status"></div>
    <form id="syncConfigForm">
      <label class="field">坚果云邮箱<input id="syncEmail" type="email" autocomplete="username" required value="${esc(c.email)}" placeholder="你的坚果云账号"></label>
      <label class="field">应用密码<input id="syncPassword" type="password" autocomplete="new-password" placeholder="${c.hasPassword?'已保存，留空不修改':'请填写专用应用密码，不是登录密码'}"></label>
      <details class="sync-help"><summary>怎么获取应用密码？</summary><p>登录坚果云网页版 → 账户信息 → 安全选项 → 第三方应用管理 → 添加应用。电脑和手机填写同一账号，可分别创建应用密码。</p><a href="https://help.jianguoyun.com/?p=2064" target="_blank" rel="noopener noreferrer">查看官方操作说明 ↗</a></details>
      <details class="sync-help"><summary>高级设置</summary><label class="field">同步文件夹<input id="syncFolder" required pattern="[a-zA-Z0-9_-]{1,64}" value="${esc(c.folder)}"></label><p class="muted small-text">两端必须一致。请不要在网盘里手动修改或删除该文件夹的内容。</p></details>
      <div class="sync-buttons"><button class="btn primary" type="submit" id="syncEnableBtn">${c.enabled?'保存连接并同步':'连接并开启同步'}</button><button class="btn" type="button" id="syncNowBtn" ${c.enabled?'':'disabled'}>立即同步</button><button class="btn ghost" type="button" id="syncPauseBtn" ${c.enabled?'':'disabled'}>暂停同步</button></div>
    </form>
    <div class="sync-buttons"><button class="btn" id="syncBackupBtn">导出完整备份</button><button class="btn" id="syncConflictBtn" hidden>核对冲突</button></div>
    <p class="muted small-text">两端前台打开时约 15 秒检查一次；后台不保证即时同步，重新打开会补同步。免费额度由坚果云规定。同步内容存于你的坚果云账户，目前不提供端到端加密。密码只留在本设备，不会进入备份。</p>
  `);
  renderSyncStatus(syncUIStatus);
  const form=document.getElementById('syncConfigForm');
  form.addEventListener('submit',async e=>{e.preventDefault();e.stopPropagation();
    const button=document.getElementById('syncEnableBtn');button.disabled=true;
    const args={enabled:true,email:document.getElementById('syncEmail').value.trim(),password:document.getElementById('syncPassword').value,folder:document.getElementById('syncFolder').value.trim()};
    try{await syncClient.configure(args);if(document.getElementById('syncPassword'))document.getElementById('syncPassword').value='';document.getElementById('syncNowBtn')?.removeAttribute('disabled');document.getElementById('syncPauseBtn')?.removeAttribute('disabled');toast(syncClient.cloudError?'连接尚未成功，请查看上方提示':'同步已开启');}catch(e){toast(e.message);}finally{button.disabled=false;}
  });
  document.getElementById('syncNowBtn').onclick=async()=>{await syncClient.tick(true);toast(syncClient.cloudError||'已完成同步检查');};
  document.getElementById('syncPauseBtn').onclick=async()=>{try{await syncClient.configure({enabled:false});toast('已暂停同步，本地记录不受影响');openSyncPanel();}catch(e){toast(e.message);}};
  document.getElementById('syncBackupBtn').onclick=()=>exportFullBackup().catch(e=>toast(e.message));
  document.getElementById('syncConflictBtn').onclick=openSyncConflicts;
}
function openSyncConflicts() {
  const conflicts=DashboardSyncCore.conflicts(syncClient.doc);
  const contexts=conflicts.map(c=>DashboardSyncCore.clone(syncClient.doc.records[c.key]));
  const names={todos:'旧日程（已停用）',transactions:'收支',subjects:'课程',deadlines:'DDL',trips:'旅行',reviews:'回顾',settings:'设置',studies:'旧知识库',courses:'旧课程'};
  openWideModal('核对同时修改的记录',`<p class="muted">不同记录会自动合并。下面这些记录曾被两端同时修改，所有版本均已保留。暂不处理不会丢失任一版本；列表和统计暂显示其中一版。建议先导出完整备份。</p><button class="btn" id="conflictExportBtn">导出所有版本</button>${conflicts.length?conflicts.map((c,i)=>{
    const [table,id]=JSON.parse(c.key);
    return `<section class="conflict-card"><h3>${esc(names[table]||table)} · ${esc(id)}</h3>${c.versions.map((v,j)=>`<div class="conflict-version"><div class="muted small-text">${esc(v.at)} · ${esc(v.actor.slice(0,13))}</div><pre>${esc(v.value===null?'（已删除）':typeof v.value==='string'?v.value:JSON.stringify(v.value,null,2))}</pre><button class="btn small" data-resolve="${i}:${j}">${v.value===null?'确认删除':'采用这个版本'}</button></div>`).join('')}</section>`;
  }).join(''):'<div class="empty">没有需要核对的记录</div>'}`);
  document.getElementById('conflictExportBtn').onclick=()=>exportFullBackup().catch(e=>toast(e.message));
  document.querySelectorAll('[data-resolve]').forEach(b=>b.onclick=async()=>{
    const [i,j]=b.dataset.resolve.split(':').map(Number),c=conflicts[i];
    if(!confirm('采用所选版本并结束这次冲突？其他版本会从待核对列表移除，建议先导出备份。'))return;
    b.disabled=true;try{await syncClient.resolve(c.key,{context:contexts[i],value:c.versions[j].value});openSyncConflicts();}catch(e){toast(e.message);b.disabled=false;}
  });
}
document.addEventListener('click',e=>{
  const bar=e.target.closest('.bar-col');if(bar&&matchMedia('(pointer:coarse)').matches)toast(bar.dataset.tip);
  if(e.target.closest('#syncBadge, #openSyncSettings'))void openSyncPanel();
  if(e.target.closest('#exportBtn'))void exportFullBackup().catch(e=>toast(e.message));
});
document.addEventListener('focusout',()=>setTimeout(()=>{if(remoteRefreshPending)applyRemoteUpdates();},100));
