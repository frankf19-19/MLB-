/* MLB 預測計分板 Service Worker — v1
   策略：頁面走網路優先（確保永遠最新版），靜態資源（隊徽/頭像/字型/圖表庫）走快取優先背景更新 */
const ASSET_CACHE='mlb-assets-v1';
const PAGE_CACHE='mlb-page-v1';
const ASSET_HOSTS=['img.mlbstatic.com','midfield.mlbstatic.com','www.mlbstatic.com','cdnjs.cloudflare.com','fonts.googleapis.com','fonts.gstatic.com'];

self.addEventListener('install',e=>{self.skipWaiting();});
self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>![ASSET_CACHE,PAGE_CACHE].includes(k)).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  // 頁面導航：網路優先，離線時回快取殼
  if(e.request.mode==='navigate'){
    e.respondWith((async()=>{
      try{
        const r=await fetch(e.request);
        const c=await caches.open(PAGE_CACHE);
        c.put('shell',r.clone());
        return r;
      }catch(_){
        const c=await caches.open(PAGE_CACHE);
        return (await c.match('shell'))||Response.error();
      }
    })());
    return;
  }
  // 靜態資源：快取優先、背景刷新
  if(ASSET_HOSTS.includes(url.hostname)){
    e.respondWith((async()=>{
      const c=await caches.open(ASSET_CACHE);
      const hit=await c.match(e.request);
      const net=fetch(e.request).then(r=>{if(r&&r.ok)c.put(e.request,r.clone());return r;}).catch(()=>null);
      return hit||net||Response.error();
    })());
  }
  // 其餘（statsapi/calib.json）一律直連網路，不快取
});
