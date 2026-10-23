/* 🧾 多季完整比賽紀錄抓取:每場投手全員 / 打者全員 / 打序 / 終場比分
 * 用法:SEASONS=2023,2024,2025,2026 node scripts/history.js
 * 2026(當季)寫入 box.json(與每日校準共用,只補缺的場次);其他季寫入 box-YYYY.json
 * 投手 [id,出局,失分,自責,被安打,K,BB,用球數,被全壘打];打者 [id,守位,AB,R,H,HR,RBI,BB,K,SB]
 */
const fs=require('fs');
const API='https://statsapi.mlb.com/api/v1';
const SEASONS=(process.env.SEASONS||'2026').split(',').map(s=>s.trim()).filter(Boolean);
const CONC=6;

async function jget(url,tries){
  tries=tries||3;
  for(let i=0;i<tries;i++){
    try{
      const r=await fetch(url,{headers:{'User-Agent':'mlb-scoreboard-history/1.0'}});
      if(!r.ok)throw new Error('HTTP '+r.status);
      return await r.json();
    }catch(e){if(i===tries-1)throw e;await new Promise(s=>setTimeout(s,1200*(i+1)));}
  }
}
function fullBox(box){
  const pt={},bt={},lu={};
  const ipOuts=ip=>{const a=String(ip||'0.0').split('.');return (parseInt(a[0])||0)*3+(parseInt(a[1])||0);};
  ['away','home'].forEach(side=>{
    const t=box.teams?.[side];if(!t)return;const k=side==='away'?'a':'h';
    pt[k]=(t.pitchers||[]).map(id=>{const s=t.players?.['ID'+id]?.stats?.pitching||{};
      return [id,ipOuts(s.inningsPitched),s.runs||0,s.earnedRuns||0,s.hits||0,s.strikeOuts||0,s.baseOnBalls||0,s.numberOfPitches||s.pitchesThrown||0,s.homeRuns||0];});
    bt[k]=Object.values(t.players||{}).filter(p=>p.stats?.batting&&((p.stats.batting.plateAppearances||0)>0)).map(p=>{const s=p.stats.batting;
      return [p.person?.id,p.position?.abbreviation||'',s.atBats||0,s.runs||0,s.hits||0,s.homeRuns||0,s.rbi||0,s.baseOnBalls||0,s.strikeOuts||0,s.stolenBases||0];});
    lu[k]=(t.battingOrder||[]).slice(0,9);
  });
  if(!(pt.a?.length||pt.h?.length||bt.a?.length||bt.h?.length))return null;
  return {pt,bt,lu};
}
async function pool(items,fn){
  let i=0;const out=[];
  await Promise.all([...Array(CONC)].map(async()=>{while(i<items.length){const it=items[i++];try{out.push(await fn(it));}catch(e){out.push(null);}}}));
  return out;
}

(async()=>{
  for(const season of SEASONS){
    const file=season===String(new Date().getFullYear())?'box.json':`box-${season}.json`;
    let BOXES={};try{BOXES=JSON.parse(fs.readFileSync(file,'utf8'))||{};}catch(e){}
    const sch=await jget(`${API}/schedule?sportId=1&season=${season}&gameTypes=R,F,D,L,W&fields=dates,date,games,gamePk,gameType,status,abstractGameState,codedGameState,teams,away,home,team,name,score`);
    const games=[];
    (sch.dates||[]).forEach(d=>(d.games||[]).forEach(g=>{
      if(g.status?.abstractGameState!=='Final'||g.status?.codedGameState==='C')return;   // 只收正式完賽,略過取消
      games.push({id:g.gamePk,d:d.date,gt:g.gameType||'R',aw:g.teams?.away?.team?.name,hm:g.teams?.home?.team?.name,sc:[g.teams?.away?.score??null,g.teams?.home?.score??null]});
    }));
    const need=games.filter(g=>!BOXES[g.id]||BOXES[g.id].empty);
    console.log(`${season}:賽程完賽 ${games.length} 場,已有 ${games.length-need.length},待抓 ${need.length}`);
    let ok=0;
    await pool(need,async g=>{
      const box=await jget(`${API}/game/${g.id}/boxscore`);const fb=fullBox(box);
      BOXES[g.id]=fb?{d:g.d,aw:g.aw,hm:g.hm,gt:g.gt,sc:g.sc,pt:fb.pt,bt:fb.bt,lu:fb.lu}:{d:g.d,aw:g.aw,hm:g.hm,gt:g.gt,sc:g.sc,empty:1};
      if(fb)ok++;
    });
    // 既有(校準寫入)場次補上比分/類型
    games.forEach(g=>{const b=BOXES[g.id];if(b){if(!b.sc)b.sc=g.sc;if(!b.gt)b.gt=g.gt;if(!b.d)b.d=g.d;}});
    fs.writeFileSync(file,JSON.stringify(BOXES));
    const v=Object.values(BOXES);
    console.log(`${season}:寫入 ${file},共 ${v.length} 場(本次新增 ${ok}),投手紀錄 ${v.reduce((s,g)=>s+(g.pt?g.pt.a.length+g.pt.h.length:0),0)} 筆、打者紀錄 ${v.reduce((s,g)=>s+(g.bt?g.bt.a.length+g.bt.h.length:0),0)} 筆`);
  }
})().catch(e=>{console.error('歷史抓取失敗:',e);process.exit(1);});
