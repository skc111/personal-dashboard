/* Offline persistence, desktop compare-and-swap and per-device WebDAV snapshots.
 * Credentials stay in the native bridge / Python service, never in exports. */
(function(root) {
  'use strict';
  const C=root.DashboardSyncCore, native=!!root.DashboardNative;
  const randomID=()=>crypto.randomUUID().replaceAll('-','');
  let rpcID=0; const callbacks=new Map();
  root.dashboardNativeReply=(id,result)=>{
    const item=callbacks.get(id); if(!item) return; callbacks.delete(id); clearTimeout(item.timer);
    result.ok ? item.resolve(result.value) : item.reject(Error(result.error||'手机接口失败'));
  };
  function rpc(action,args={}) {
    if(!native) return fetch('/api/sync/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Dashboard-Client':'sync-v1'},body:JSON.stringify(args),signal:AbortSignal.timeout(45000)})
      .then(async r=>{const data=await r.json(); if(!r.ok||!data.ok) throw Error(data.error||'本地服务连接失败'); return data.value;});
    return new Promise((resolve,reject)=>{
      const id=String(++rpcID), timer=setTimeout(()=>{callbacks.delete(id);reject(Error('连接超时；本地记录已保留'));},action==='export'?300000:45000);
      callbacks.set(id,{resolve,reject,timer}); root.DashboardNative.request(id,JSON.stringify({action,args}));
    });
  }
  let idb;
  async function database() {
    if(idb) return idb;
    idb=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('personal-dashboard-offline-v1',1);
      r.onupgradeneeded=()=>r.result.createObjectStore('state');
      r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
    }); return idb;
  }
  async function readCache() {
    if(native) {const s=root.DashboardNative.readLocal(); const r=JSON.parse(s); if(!r.ok) throw Error(r.error); return r.value;}
    const db=await database();
    return new Promise((resolve,reject)=>{const t=db.transaction('state'),r=t.objectStore('state').get('current');r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);});
  }
  async function writeCache(value) {
    if(native) {const r=JSON.parse(root.DashboardNative.writeLocal(JSON.stringify(value)));if(!r.ok)throw Error(r.error);return;}
    const db=await database();
    return new Promise((resolve,reject)=>{
      const t=db.transaction('state','readwrite'),s=t.objectStore('state'),r=s.get('current');let merged=value;
      r.onsuccess=()=>{try {if(r.result){merged={...value,doc:C.merge(value.doc,r.result.doc),device:r.result.device||value.device};}s.put(merged,'current');}catch(e){reject(e);t.abort();}};
      t.oncomplete=()=>resolve(merged);t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||Error('本地保存被中断'));
    });
  }
  async function download(name,text,mime='application/json') {
    if(native) return rpc('export',{name,text,mime});
    const a=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{type:mime}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  class Client {
    constructor(onChange,onStatus) {
      this.onChange=onChange;this.onStatus=onStatus;this.doc=C.empty();this.viewDoc=C.empty();
      this.actor='edit-'+randomID();this.sequence=0;this.revision='';this.serverBody='';
      this.localQueue=Promise.resolve();this.localWrites=0;this.tags=new Map();this.ownConfirmed='';
      this.config={enabled:false};this.lastSync='';this.localError='';this.cloudError='';this.desktopError='';
      this.backoffUntil=0;this.failures=0;this.running=false;this.ready=false;this.localRunning=false;this.timer=null;
    }
    browserOnly() {
      if(native||!this.ready)return false;
      const content=C.stable(this.doc);
      return content!==this.serverBody&&content!==this.ownConfirmed;
    }
    needsExitWarning() {
      return !!(this.localWrites||this.localError||this.browserOnly());
    }
    status() {
      const conflicts=C.conflicts(this.doc).length;
      let text;
      if(this.localError) text='本地保存失败，请立即导出';
      else if(this.localWrites) text='正在保存到本地…';
      else if(this.cloudError) text='已保存本地 · 同步待重试';
      else if(this.desktopError) text='已保存浏览器 · 待写入电脑';
      else if(this.running) text='已保存本地 · 同步中…';
      else if(!this.config.enabled) text='已保存本地 · 未开启同步';
      else if(this.ownConfirmed!==C.stable(this.doc)) text='已保存本地 · 等待同步';
      else text='已同步 '+new Date(this.lastSync).toLocaleTimeString('zh-CN',{hour12:false});
      if(conflicts) text+=' · '+conflicts+' 项待核对';
      this.onStatus({text,conflicts,error:this.localError||this.cloudError||this.desktopError,lastSync:this.lastSync,enabled:this.config.enabled,running:this.running,browserOnly:this.browserOnly()});
    }
    async init() {
      const cached=await readCache();
      if(cached) {C.validate(cached.doc);this.doc=cached.doc;this.device=cached.device;this.lastSync=cached.lastSync||'';}
      if(!this.device) this.device=randomID();
      if(!native) {
        try {await this.pullDesktop();} catch(e) {if(!cached) throw e;this.desktopError=e.message;}
      }
      await this.persist();this.viewDoc=C.clone(this.doc);
      try {this.config=await rpc('configGet');} catch(e) {this.desktopError=e.message;}
      this.ready=true;this.status();return C.materialize(this.viewDoc);
    }
    start() {
      this.tick();this.timer=setInterval(()=>{if(!document.hidden&&root.dashboardForeground!==false)this.tick();},15000);
      const resume=()=>{if(!document.hidden&&root.dashboardForeground!==false)this.tick(true);};
      document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);window.addEventListener('dashboard-resume',resume);
      if(!native) {
        this.localTimer=setInterval(()=>{if(!document.hidden)this.flushDesktop().catch(()=>{});},5000);
        window.addEventListener('beforeunload',e=>{if(this.needsExitWarning()){e.preventDefault();e.returnValue='';}});
      }
    }
    persist() {
      const snapshot={doc:C.clone(this.doc),device:this.device,lastSync:this.lastSync};this.localWrites++;this.status();
      const job=this.localQueue.catch(()=>{}).then(()=>writeCache(snapshot));this.localQueue=job;
      return job.then(saved=>{this.localError='';if(saved){this.device=saved.device;const merged=C.merge(this.doc,saved.doc);if(!C.equal(merged,this.doc)){this.doc=merged;this.onChange();}}},e=>{this.localError=e.message;throw e;}).finally(()=>{this.localWrites--;this.status();});
    }
    commit(db) {
      const change=C.edit(this.viewDoc,db,this.actor,this.sequence);
      this.sequence=change.n;this.doc=C.merge(this.doc,change.doc);this.viewDoc=change.doc;
      return this.persist().then(()=>{this.onChange();return this.flushDesktop();}).catch(e=>{this.status();throw e;});
    }
    takeView() {this.viewDoc=C.clone(this.doc);return C.materialize(this.viewDoc);}
    async accept(doc) {
      const merged=C.merge(this.doc,C.validate(doc));
      if(C.equal(merged,this.doc)) return false;
      this.doc=merged;await this.persist();this.onChange();return true;
    }
    async fromServer(data) {
      if(data._schema<5||!data._revision) throw Error('电脑服务版本较旧，请重新双击「启动面板.vbs」');
      const doc=data._sync||await C.seed(data);
      C.validate(doc);this.revision=data._revision;
      this.serverBody=data._sync?C.stable(doc):'';
      await this.accept(doc);
    }
    async pullDesktop() {
      const response=await fetch('/api/data',{cache:'no-store',signal:AbortSignal.timeout(10000)});
      const data=await response.json();if(!response.ok)throw Error(data.error||'读取电脑数据失败');
      await this.fromServer(data);this.desktopError='';
    }
    async flushDesktop() {
      if(native||this.localRunning||!this.ready) return;
      this.localRunning=true;
      try {
        await this.localQueue;await this.pullDesktop();
        for(let attempt=0;attempt<5;attempt++) {
          const snapshot=C.clone(this.doc),body=C.stable(snapshot);
          if(body===this.serverBody) break;
          await this.persist();
          const response=await fetch('/api/save',{method:'PUT',headers:{'Content-Type':'application/json','If-Match':this.revision,'X-Dashboard-Client':'sync-v1'},body:JSON.stringify({...C.materialize(snapshot),_sync:snapshot}),signal:AbortSignal.timeout(15000)});
          const result=await response.json();
          if(response.status===409){await this.pullDesktop();continue;}
          if(!response.ok||!result.ok) throw Error(result.error||'写入电脑失败');
          this.revision=result.revision;this.serverBody=body;this.desktopError='';
        }
        if(C.stable(this.doc)!==this.serverBody) this.desktopError='其他页面正在写入，稍后自动合并';
      } catch(e) {this.desktopError=e.message;}
      finally {this.localRunning=false;this.status();}
    }
    async tick(force=false) {
      if(this.running||!this.ready) return;
      this.running=true;this.status();
      try {
        if(this.localError)await this.persist();
        await this.flushDesktop();
        try {this.config=await rpc('configGet');} catch(e) {this.desktopError=e.message;return;}
        if(!this.config.enabled || (!force&&Date.now()<this.backoffUntil))return;
        if(!native&&!navigator.locks)throw Error('当前浏览器不支持安全的多标签同步，请使用新版 Edge 或 Chrome');
        const work=async()=>{await this.syncCloud();};
        if(navigator.locks) await navigator.locks.request('personal-dashboard-cloud-v1',{ifAvailable:true},async lock=>{if(lock)await work();});
        else await work();
      } catch(e) {
        this.cloudError=e.message;this.failures++;this.backoffUntil=Date.now()+Math.min(300000,15000*2**Math.min(this.failures,5));
      } finally {this.running=false;this.status();}
    }
    async syncCloud() {
      // Another tab sharing this device may have saved while we waited for a lock.
      const cached=await readCache();if(cached)await this.accept(cached.doc);
      await this.localQueue;
      if(!this.cloudReady){await rpc('dav',{op:'mkdir'});this.cloudReady=true;}
      const list=await rpc('dav',{op:'list'});
      if(!Array.isArray(list)||list.length>=700)throw Error('同步目录文件过多，已暂停；请勿手动删除同步文件');
      const own='device-'+this.device+'.json';
      if(!list.some(x=>x.name===own))this.ownConfirmed='';
      for(const file of list) {
        if(!/^device-[a-f0-9]{32}\.json$/.test(file.name)) continue;
        if(file.etag && this.tags.get(file.name)===file.etag) continue;
        const reply=await rpc('dav',{op:'get',name:file.name});
        const envelope=JSON.parse(reply.body);
        if(envelope.app!=='personal-dashboard'||envelope.protocol!==1) throw Error('发现无法识别的同步文件，已保留本地记录');
        await this.accept(envelope.doc);
        if(file.name===own) this.ownConfirmed=C.stable(envelope.doc);
        this.tags.set(file.name,reply.etag||file.etag);
      }
      await this.flushDesktop();await this.localQueue;
      const snapshot=C.clone(this.doc),content=C.stable(snapshot);
      if(content!==this.ownConfirmed) {
        const result=await rpc('dav',{op:'put',name:own,body:JSON.stringify({app:'personal-dashboard',protocol:1,doc:snapshot})});
        this.ownConfirmed=content;this.tags.set(own,result.etag||'');
      }
      this.lastSync=new Date().toISOString();this.cloudError='';this.failures=0;this.backoffUntil=0;
      await this.persist();this.onChange();
    }
    async configure(args) {
      if(this.running)throw Error('正在同步，请完成后再修改连接设置');
      this.config=await rpc('configSave',args);this.tags.clear();this.ownConfirmed='';this.cloudReady=false;this.cloudError='';this.backoffUntil=0;
      this.status();if(this.config.enabled)await this.tick(true);
    }
    async importData(db) {
      if(!C.TABLES.some(k=>Array.isArray(db?.[k])))throw Error('不是面板 JSON 备份');
      const doc=db._sync?C.validate(db._sync):await C.seed(db);
      await this.accept(doc);await this.flushDesktop();
    }
    async resolve(key,version) {
      const r=this.doc.records[key];if(!r)throw Error('记录已变化，请重新打开');
      // Caller passes the entire versions snapshot so an arriving edit isn't
      // accidentally included in the resolution's observed context.
      const snapshot=version.context;
      const patch=C.empty();patch.records[key]=C.clone(snapshot);
      const updated=C.update(patch,key,version.value,this.actor,++this.sequence);
      await this.accept(updated);await this.flushDesktop();
    }
    exportData() {return {...C.materialize(this.doc),_sync:C.clone(this.doc)};}
  }
  root.DashboardSync={Client,native,rpc,download};
})(globalThis);
