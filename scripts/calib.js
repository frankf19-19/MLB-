/*
  MLB 預測計分板 — 雲端每日校準腳本
  Copyright (c) 2026 frankf19-19. All Rights Reserved.
  每天由 GitHub Actions 執行:回測近況、累積整季紀錄簿、擬合 K/σ,輸出 calib.json 供所有裝置共用。
*/
const fs=require('fs');
const API='https://statsapi.mlb.com/api/v1';
const FILE='calib.json';
const FIT_DAYS=60;          // 校準擬合窗口
const BOOTSTRAP_DAYS=75;    // 首次執行回補天數
const HOME_RUN_BOOST=0.20;
const PARK_F={115:1.18,111:1.06,113:1.06,109:1.03,118:1.03,145:1.03,147:1.03,
  141:1.02,143:1.02,133:1.02,136:0.94,135:0.96,137:0.96,121:0.97,119:0.98,146:0.97};

/* ---------- 工具 ---------- */
function erf(x){const s=x<0?-1:1;x=Math.abs(x);const t=1/(1+0.3275911*x);
  const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);return s*y;}
const normCdf=z=>0.5*(1+erf(z/Math.SQRT2));
function etToday(){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  return p; // en-CA 給 YYYY-MM-DD
}
function shiftDate(d,n){const t=new Date(d+'T12:00:00Z');t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10);}
async function jget(url,tries){
  tries=tries||3;
  for(let i=0;i<tries;i++){
    try{
      const r=await fetch(url,{headers:{'User-Agent':'mlb-scoreboard-calib/1.0'}});
      if(!r.ok)throw new Error('HTTP '+r.status);
      return await r.json();
    }catch(e){if(i===tries-1)throw e;await new Promise(s=>setTimeout(s,1200*(i+1)));}
  }
}
const ipOuts=s=>{const p=String(s||'0').split('.');return (parseInt(p[0])||0)*3+(parseInt(p[1])||0);};

/* ---------- 資料抓取(與網頁版一致) ---------- */
async function fetchStandingsAsOf(date){
  const y=+date.slice(0,4);
  const d=await jget(`${API}/standings?leagueId=103,104&season=${y}&standingsTypes=regularSeason&date=${date}`);
  const pm={};
  (d.records||[]).forEach(rec=>(rec.teamRecords||[]).forEach(t=>{
    pm[t.team.id]={w:t.wins,l:t.losses,pct:parseFloat(t.winningPercentage)||.5,
      rs:t.runsScored,ra:t.runsAllowed,gp:(t.wins||0)+(t.losses||0)};
  }));
  return pm;
}
function leagueRPG(pm){
  let rs=0,gp=0;Object.values(pm).forEach(t=>{if(t.rs!=null&&t.gp){rs+=t.rs;gp+=t.gp;}});
  return gp?rs/gp:4.5;
}
const schedCache={};
async function fetchGames(date){
  if(schedCache[date])return schedCache[date];
  const d=await jget(`${API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,team,linescore`);
  const games=[];
  (d.dates||[]).forEach(dt=>(dt.games||[]).forEach(g=>{
    const ls=g.linescore||{};
    games.push({id:g.gamePk,ts:g.gameDate,detail:g.status?.detailedState||'',
      status:g.status?.abstractGameState||'',
      away:g.teams?.away?.team?.name,home:g.teams?.home?.team?.name,
      awayId:g.teams?.away?.team?.id,homeId:g.teams?.home?.team?.id,
      awayScore:g.teams?.away?.score,homeScore:g.teams?.home?.score,
      awayWin:!!g.teams?.away?.isWinner,homeWin:!!g.teams?.home?.isWinner,
      awayPitId:g.teams?.away?.probablePitcher?.id,homePitId:g.teams?.home?.probablePitcher?.id,
      curInn:ls.currentInning,
      inns:(ls.innings||[]).map(i=>({a:i.away?.runs??0,h:i.home?.runs??0}))});
  }));
  schedCache[date]=games;return games;
}
async function fetchPitcherStats(ids,season,endDate){
  const out={};if(!ids.length)return out;
  const parseInto=(d,key)=>{(d.people||[]).forEach(p=>{
    const sp=(p.stats||[]).find(s=>s.group?.displayName==='pitching')?.splits||[];
    if(!sp.length)return;const st=sp[sp.length-1].stat||{};
    const era=parseFloat(st.era),ip=parseFloat(st.inningsPitched);
    const so=parseInt(st.strikeOuts),bb=parseInt(st.baseOnBalls),hr=parseInt(st.homeRuns);
    const gsN=parseInt(st.gamesStarted);
    if(isFinite(era)&&isFinite(ip)){out[p.id]=out[p.id]||{};out[p.id][key]={era,ip,
      so:isFinite(so)?so:null,bb:isFinite(bb)?bb:null,hr:isFinite(hr)?hr:null,
      gs:isFinite(gsN)?gsN:null};
      out[p.id].hand=p.pitchHand?.code||out[p.id].hand;}});};
  try{parseInto(await jget(`${API}/people?personIds=${ids.join(',')}&hydrate=stats(group=[pitching],type=[byDateRange],startDate=${season}-01-01,endDate=${endDate},season=${season})`),'season');}catch(e){}
  try{parseInto(await jget(`${API}/people?personIds=${ids.join(',')}&hydrate=stats(group=[pitching],type=[byDateRange],startDate=${shiftDate(endDate,-29)},endDate=${endDate},season=${season})`),'recent');}catch(e){}
  try{
    const dg=await jget(`${API}/people?personIds=${ids.join(',')}&hydrate=stats(group=[pitching],type=[gameLog],season=${season})`);
    (dg.people||[]).forEach(p=>{
      const sp0=(p.stats||[]).find(s=>s.group?.displayName==='pitching')?.splits||[];
      const sp=sp0.filter(s=>s.date&&s.date<=endDate);
      if(!sp.length)return;
      const last=sp[sp.length-1];
      const pit=parseInt(last.stat?.numberOfPitches);
      out[p.id]=out[p.id]||{};
      out[p.id].lastOut={d:last.date,pit:isFinite(pit)?pit:null};
    });
  }catch(e){}
  try{
    const d=await jget(`${API}/people?personIds=${ids.join(',')}&hydrate=stats(group=[pitching],type=[statSplits],sitCodes=[h,a],season=${season})`);
    (d.people||[]).forEach(p=>{
      const sp=(p.stats||[]).find(s=>s.group?.displayName==='pitching')?.splits||[];
      sp.forEach(s=>{
        const code=(s.split?.code||'').toLowerCase();
        const era=parseFloat(s.stat?.era),ip=parseFloat(s.stat?.inningsPitched);
        if(!isFinite(era)||!isFinite(ip))return;
        out[p.id]=out[p.id]||{};
        if(code==='h')out[p.id].vH={era,ip};else if(code==='a')out[p.id].vA={era,ip};
      });
    });
  }catch(e){}
  Object.values(out).forEach(o=>{
    const s=o.season,r=o.recent;
    if(s){
      let era=s.era;
      if(r&&r.ip>=8){const wr=0.35*r.ip/(r.ip+15);era=(1-wr)*s.era+wr*r.era;}
      o.era=era;o.ip=s.ip;o.seasonEra=s.era;
      if(s.gs>=3)o.ipStart=Math.max(3,Math.min(7.5,s.ip/s.gs));
      if(s.ip>=20&&s.so!=null&&s.bb!=null&&s.hr!=null){
        const fip=(13*s.hr+3*s.bb-2*s.so)/s.ip+3.15;
        if(isFinite(fip)&&fip>0)o.era=0.6*o.era+0.4*fip;
      }
    }else if(r){o.era=r.era;o.ip=r.ip;}
  });
  return out;
}
async function fetchTeamExtras(season,asOf){
  const ex={map:{},lgOPS:null,lgBpEra:null};
  const put=(id,k,v)=>{(ex.map[id]=ex.map[id]||{})[k]=v;};
  try{
    const d=await jget(`${API}/teams/stats?sportId=1&group=hitting&stats=season&season=${season}`);
    ((d.stats||[])[0]?.splits||[]).forEach(s=>{const id=s.team?.id,ops=parseFloat(s.stat?.ops);
      if(id&&isFinite(ops))put(id,'ops',ops);});
    const v=Object.values(ex.map).map(t=>t.ops).filter(isFinite);
    if(v.length)ex.lgOPS=v.reduce((a,b)=>a+b,0)/v.length;
  }catch(e){}
  try{
    const d=await jget(`${API}/teams/stats?sportId=1&group=pitching&stats=statSplits&sitCodes=rp&season=${season}`);
    ((d.stats||[])[0]?.splits||[]).forEach(s=>{const id=s.team?.id,era=parseFloat(s.stat?.era),ip=parseFloat(s.stat?.inningsPitched);
      if(id&&isFinite(era)&&isFinite(ip)&&ip>=30)put(id,'bpEra',era);});
    const v=Object.values(ex.map).map(t=>t.bpEra).filter(isFinite);
    if(v.length)ex.lgBpEra=v.reduce((a,b)=>a+b,0)/v.length;
  }catch(e){}
  try{
    const d=await jget(`${API}/teams/stats?sportId=1&group=hitting&stats=statSplits&sitCodes=vl,vr&season=${season}`);
    ((d.stats||[])[0]?.splits||[]).forEach(s=>{
      const id=s.team?.id,ops=parseFloat(s.stat?.ops),code=s.split?.code||s.split?.description||'';
      if(id&&isFinite(ops)){if(/vl/i.test(code))put(id,'vsL',ops);else if(/vr/i.test(code))put(id,'vsR',ops);}});
  }catch(e){}
  try{
    const d=await jget(`${API}/teams/stats?sportId=1&group=hitting&stats=statSplits&sitCodes=h,a&season=${season}`);
    ((d.stats||[])[0]?.splits||[]).forEach(s=>{
      const id=s.team?.id,r=parseFloat(s.stat?.runs),gp=parseFloat(s.stat?.gamesPlayed),code=s.split?.code||'';
      if(id&&isFinite(r)&&gp>=8){if(/^h/i.test(code))put(id,'homeRSg',r/gp);else if(/^a/i.test(code))put(id,'awayRSg',r/gp);}});
  }catch(e){}
  try{
    const d=await jget(`${API}/teams/stats?sportId=1&group=pitching&stats=statSplits&sitCodes=h,a&season=${season}`);
    ((d.stats||[])[0]?.splits||[]).forEach(s=>{
      const id=s.team?.id,r=parseFloat(s.stat?.runs),gp=parseFloat(s.stat?.gamesPlayed),code=s.split?.code||'';
      if(id&&isFinite(r)&&gp>=8){if(/^h/i.test(code))put(id,'homeRAg',r/gp);else if(/^a/i.test(code))put(id,'awayRAg',r/gp);}});
  }catch(e){}
  if(asOf){
    const from=shiftDate(asOf,-13);
    try{
      const d=await jget(`${API}/teams/stats?sportId=1&group=hitting&stats=byDateRange&startDate=${from}&endDate=${asOf}&season=${season}`);
      ((d.stats||[])[0]?.splits||[]).forEach(s=>{
        const id=s.team?.id,r=parseFloat(s.stat?.runs),gp=parseFloat(s.stat?.gamesPlayed);
        if(id&&isFinite(r)&&gp>=5)put(id,'recRSg',r/gp);});
    }catch(e){}
    try{
      const d=await jget(`${API}/teams/stats?sportId=1&group=pitching&stats=byDateRange&startDate=${from}&endDate=${asOf}&season=${season}`);
      ((d.stats||[])[0]?.splits||[]).forEach(s=>{
        const id=s.team?.id,r=parseFloat(s.stat?.runs),gp=parseFloat(s.stat?.gamesPlayed);
        if(id&&isFinite(r)&&gp>=5)put(id,'recRAg',r/gp);});
    }catch(e){}
  }
  return ex;
}
async function bpFatigue(date){
  const days=[shiftDate(date,-1),shiftDate(date,-2),shiftDate(date,-3)];
  const packs=[];
  for(const d of days){try{packs.push(await fetchGames(d));}catch(e){packs.push([]);}}
  const f={};
  packs.forEach((games,di)=>games.forEach(g=>{
    if(g.status!=='Final')return;
    [g.awayId,g.homeId].forEach(id=>{f[id]=(f[id]||0)+1;});
    if(di===0){
      const close=Math.abs((g.homeScore??0)-(g.awayScore??0))<=1;
      const extra=(g.curInn||9)>9;
      if(close||extra)[g.awayId,g.homeId].forEach(id=>{f[id]=(f[id]||0)+0.7;});
    }
  }));
  return f;
}

/* ⑭ 本季對戰(與網頁版一致;只算該場之前) */
const h2hCache={};
async function fetchH2H(g,season,cutoff){
  const key=[g.awayId,g.homeId].sort().join('-')+cutoff;
  if(h2hCache[key]!==undefined)return h2hCache[key];
  try{
    const d=await jget(`${API}/schedule?sportId=1&season=${season}&teamId=${g.homeId}&opponentId=${g.awayId}&fields=dates,date,games,gamePk,officialDate,status,abstractGameState,teams,away,home,team,id,isWinner`);
    let hw=0,aw=0;
    (d.dates||[]).forEach(dt=>(dt.games||[]).forEach(gm=>{
      if(gm.status?.abstractGameState!=='Final')return;
      const gd=gm.officialDate||dt.date;
      if(cutoff&&gd>=cutoff)return;
      const ids=[gm.teams?.away?.team?.id,gm.teams?.home?.team?.id];
      if(!ids.includes(g.awayId)||!ids.includes(g.homeId))return;
      const winId=gm.teams?.home?.isWinner?gm.teams.home.team.id:(gm.teams?.away?.isWinner?gm.teams.away.team.id:null);
      if(winId===g.homeId)hw++;else if(winId===g.awayId)aw++;
    }));
    h2hCache[key]={a:aw,h:hw};return h2hCache[key];
  }catch(e){h2hCache[key]=null;return null;}
}

/* ⑬ 天氣層(與網頁版一致) */
const PARK_GEO={144:[33.891,-84.468],110:[39.284,-76.622],111:[42.346,-71.097],
  112:[41.948,-87.655],145:[41.830,-87.634],113:[39.097,-84.507],114:[41.496,-81.685],
  115:[39.756,-104.994],116:[42.339,-83.049],118:[39.051,-94.480],108:[33.800,-117.883],
  119:[34.074,-118.240],142:[44.982,-93.278],121:[40.757,-73.846],147:[40.829,-73.926],
  133:[38.580,-121.513],143:[39.906,-75.166],134:[40.447,-80.006],135:[32.707,-117.157],
  137:[37.778,-122.389],138:[38.622,-90.193],139:[27.980,-82.507],120:[38.873,-77.007]};
const wxCache={};
async function fetchWxTemp(teamId,tsIso){
  const geo=PARK_GEO[teamId];
  if(!geo||!tsIso)return null;
  try{
    const key='w'+teamId;
    if(wxCache[key]===undefined){
      const r=await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${geo[0]}&longitude=${geo[1]}&hourly=temperature_2m&past_days=3&forecast_days=2&timezone=auto`);
      wxCache[key]=r.ok?await r.json():null;
    }
    const d=wxCache[key];
    if(!d||!d.hourly||!d.hourly.time)return null;
    const local=new Date(new Date(tsIso).getTime()+(d.utc_offset_seconds||0)*1000).toISOString().slice(0,13);
    const idx=d.hourly.time.findIndex(t=>t.startsWith(local));
    return idx>=0?d.hourly.temperature_2m[idx]:null;
  }catch(e){return null;}
}

/* ⑫ 當日打線名單(與網頁版一致;回測用實際先發九人) */
async function fetchLineupRatio(g,exMap,asOf){
  try{
    const box=await jget(`${API}/game/${g.id}/boxscore`);
    const orders={};
    ['away','home'].forEach(side=>{
      const t=box.teams?.[side];const order=t?.battingOrder||[];
      if(order.length>=9)orders[side]=order.slice(0,9).map(id=>({id,
        sOPS:parseFloat(t.players?.['ID'+id]?.seasonStats?.batting?.ops)}));
    });
    const allIds=[...(orders.away||[]),...(orders.home||[])].map(o=>o.id);
    const recMap={};
    if(allIds.length&&asOf){
      try{
        const start=shiftDate(asOf,-13),yr=asOf.slice(0,4);
        const d=await jget(`${API}/people?personIds=${allIds.join(',')}&hydrate=stats(group=[hitting],type=[byDateRange],startDate=${start},endDate=${asOf},season=${yr})`);
        (d.people||[]).forEach(p=>{
          const sp=(p.stats||[]).find(s=>s.group?.displayName==='hitting')?.splits||[];
          if(!sp.length)return;
          const st=sp[sp.length-1].stat||{};
          const ops=parseFloat(st.ops),ab=parseInt(st.atBats);
          if(isFinite(ops)&&isFinite(ab)&&ab>=15)recMap[p.id]={ops,ab};
        });
      }catch(e){}
    }
    const spMap={};
    if(allIds.length&&asOf){
      try{
        const yr2=asOf.slice(0,4);
        const ds=await jget(`${API}/people?personIds=${allIds.join(',')}&hydrate=stats(group=[hitting],type=[statSplits],sitCodes=[vl,vr],season=${yr2})`);
        (ds.people||[]).forEach(p=>{
          const sp=(p.stats||[]).find(s=>s.group?.displayName==='hitting')?.splits||[];
          const rec={};
          sp.forEach(s=>{
            const code=(s.split?.code||s.split?.description||'');
            const ops=parseFloat(s.stat?.ops),pa=parseInt(s.stat?.plateAppearances);
            if(!(isFinite(ops)&&isFinite(pa)&&pa>=40))return;
            if(/vl/i.test(code))rec.vl=ops;else if(/vr/i.test(code))rec.vr=ops;
          });
          if(rec.vl||rec.vr)spMap[p.id]=rec;
        });
      }catch(e){}
    }
    const sideSplit=side=>{
      const os=(orders[side]||[]);
      const pack=hand=>{
        const arr=os.map(o=>{
          const s2=spMap[o.id];
          const v=s2?(hand==='L'?s2.vl:s2.vr):null;
          return (isFinite(v)&&isFinite(o.sOPS)&&o.sOPS>0)?{v,s:o.sOPS}:null;
        }).filter(Boolean);
        if(arr.length<6)return null;
        return arr.reduce((t,x)=>t+x.v,0)/arr.reduce((t,x)=>t+x.s,0);
      };
      return {L:pack('L'),R:pack('R')};
    };
    const luSp={a:sideSplit('away'),h:sideSplit('home')};
    const eff=o=>{
      if(!(isFinite(o.sOPS)&&o.sOPS>0))return null;
      const r2=recMap[o.id];
      if(!r2)return o.sOPS;
      const w=Math.min(0.35,r2.ab/(r2.ab+60));
      return o.sOPS*(1-w)+r2.ops*w;
    };
    const calc=side=>{
      const arr=(orders[side]||[]).map(eff).filter(v=>v!=null);
      if(arr.length<7)return null;
      return arr.reduce((s,v)=>s+v,0)/arr.length;
    };
    const a=calc('away'),h=calc('home');
    return {
      a:(a&&isFinite(exMap[g.awayId]?.ops)&&exMap[g.awayId].ops>0)?a/exMap[g.awayId].ops:null,
      h:(h&&isFinite(exMap[g.homeId]?.ops)&&exMap[g.homeId].ops>0)?h/exMap[g.homeId].ops:null,
      sp:luSp
    };
  }catch(e){return null;}
}
const luAdj=r=>{if(!Number.isFinite(r)||r<=0)return 1;return 1+Math.max(-0.06,Math.min(0.06,(r-1)*0.5));};

/* ⑪ 球隊偏差校正(與網頁版一致) */
function computeTeamBias(ledger,K){
  const L=(ledger||[]).filter(x=>x.m!=null&&x.am!=null);
  if(L.length<150)return {};
  const ds=[...new Set(L.map(x=>x.d))].sort();
  const cut=ds[Math.max(0,ds.length-30)];
  const accS={},accR={};
  L.forEach(x=>{
    const r=x.am-x.m*K;
    (accS[x.hm]=accS[x.hm]||{s:0,n:0}).s+=r;accS[x.hm].n++;
    (accS[x.aw]=accS[x.aw]||{s:0,n:0}).s-=r;accS[x.aw].n++;
    if(x.d>=cut){
      (accR[x.hm]=accR[x.hm]||{s:0,n:0}).s+=r;accR[x.hm].n++;
      (accR[x.aw]=accR[x.aw]||{s:0,n:0}).s-=r;accR[x.aw].n++;
    }
  });
  const out={};
  Object.keys(accS).forEach(nm=>{
    const S=accS[nm];if(S.n<20)return;
    const bS=(S.s/S.n)*S.n/(S.n+100);
    const R=accR[nm];
    const bR=(R&&R.n>=10)?(R.s/R.n)*R.n/(R.n+40):bS;
    out[nm]=Math.max(-0.35,Math.min(0.35,bS*0.4+bR*0.6));
  });
  return out;
}

/* ---------- 預測模型(與網頁版一致,回傳 pre-K 分差與期望分) ---------- */
function predict(g,pm,lg,ps,ex,teamBias,tune){
  const stW=(tune&&tune.stW)||1, bpW=(tune&&tune.bpW)||1, luW=(tune&&tune.luW)||1;
  const H=pm[g.homeId]||{},A=pm[g.awayId]||{};
  if(!(lg&&H.rs!=null&&H.ra!=null&&H.gp&&A.rs!=null&&A.ra!=null&&A.gp))return null;
  const hRS=H.rs/H.gp,hRA=H.ra/H.gp,aRS=A.rs/A.gp,aRA=A.ra/A.gp;
  const exm=ex?.map||{},lgOPS=ex?.lgOPS;
  const exH=exm[g.homeId]||{},exA=exm[g.awayId]||{};
  const offense=(rsPg,ops,rec)=>{
    const opsRuns=(lgOPS&&isFinite(ops))?lg*Math.pow(ops/lgOPS,1.8):null;
    const parts=[[rsPg,0.5]];
    if(isFinite(rec))parts.push([rec,0.25]);
    if(opsRuns!=null)parts.push([opsRuns,0.25]);
    const w=parts.reduce((s,p)=>s+p[1],0);
    return parts.reduce((s,p)=>s+p[0]*p[1],0)/w;
  };
  const defense=(raPg,rec)=>isFinite(rec)?0.7*raPg+0.3*rec:raPg;
  const hOff=offense(hRS,exH.ops,exH.recRSg),aOff=offense(aRS,exA.ops,exA.recRSg);
  const hDef=defense(hRA,exH.recRAg),aDef=defense(aRA,exA.recRAg);
  const hSt=ps?ps[g.homePitId]:null,aSt=ps?ps[g.awayPitId]:null;
  const platoon=(ex2,oppHand,base)=>{
    if(!ex2||!oppHand)return base;
    const sp=oppHand==='L'?ex2.vsL:ex2.vsR;
    if(!(isFinite(sp)&&isFinite(ex2.ops)&&ex2.ops>0))return base;
    const ratio=Math.max(.92,Math.min(1.08,1+(sp/ex2.ops-1)*0.6));
    return base*ratio;
  };
  const luPlat=(side,oppHand)=>{
    const s2=g.luSp&&g.luSp[side];
    if(!s2||!oppHand)return null;
    const rr=oppHand==='L'?s2.L:s2.R;
    if(!isFinite(rr))return null;
    return Math.max(.92,Math.min(1.08,1+(rr-1)*0.5));
  };
  const teamRatio=(ex2,oppHand)=>{
    if(!ex2||!oppHand)return null;
    const sp=oppHand==='L'?ex2.vsL:ex2.vsR;
    if(!(isFinite(sp)&&isFinite(ex2.ops)&&ex2.ops>0))return null;
    return Math.max(.92,Math.min(1.08,1+(sp/ex2.ops-1)*0.6));
  };
  const mixPl=(ex2,oppHand,side,base)=>{
    const rT=teamRatio(ex2,oppHand),rL=luPlat(side,oppHand);
    if(rL==null)return platoon(ex2,oppHand,base);
    const rF=Math.max(.92,Math.min(1.08,(rT||1)*0.4+rL*0.6));
    return base*rF;
  };
  const hPl=mixPl(exH,aSt?.hand,'h',hOff),aPl=mixPl(exA,hSt?.hand,'a',aOff);
  const venMix=(base,split)=>isFinite(split)?base*0.8+split*0.2:base;
  const hOffV=venMix(hPl,exH.homeRSg),aOffV=venMix(aPl,exA.awayRSg);
  const hDefV=venMix(hDef,exH.homeRAg),aDefV=venMix(aDef,exA.awayRAg);
  const luH=Math.max(.925,Math.min(1.075,1+(luAdj(g.luH)-1)*luW));
  const luA=Math.max(.925,Math.min(1.075,1+(luAdj(g.luA)-1)*luW));
  let expHome=(hOffV*luH/lg)*(aDefV/lg)*lg+HOME_RUN_BOOST,expAway=(aOffV*luA/lg)*(hDefV/lg)*lg;
  const fat=ex?.fatigue||{};
  if((fat[g.homeId]||0)>=3.5)expAway+=0.2;
  if((fat[g.awayId]||0)>=3.5)expHome+=0.2;
  const lgERA=lg*0.92;
  const venueEra=(st,side)=>{
    if(!st)return st;
    const v=side==='h'?st.vH:st.vA;
    if(!v||!(v.ip>=25))return st;
    const w=0.25*v.ip/(v.ip+40);
    return Object.assign({},st,{era:(1-w)*st.era+w*v.era});
  };
  const hStV=venueEra(hSt,'h'),aStV=venueEra(aSt,'a');
  const stAdj=st=>{
    if(!st||!(st.ip>=10))return null;
    const w=st.ip/(st.ip+40);
    return Math.max(-0.8,Math.min(0.8,(st.era-lgERA)/9*5.8*w*0.5));
  };
  const dHome=stAdj(hStV),dAway=stAdj(aStV);
  const gd0=(g.ts||'').slice(0,10);
  const restInfo=st2=>{
    if(!st2||!st2.lastOut||!st2.lastOut.d||!gd0)return null;
    const gap=Math.round((new Date(gd0)-new Date(st2.lastOut.d))/864e5);
    if(!(gap>0&&gap<60))return null;
    return {gap,pit:st2.lastOut.pit};
  };
  const restAdj=(st2)=>{
    const ri=restInfo(st2);if(!ri)return {pen:0,shrink:1,note:null};
    let pen=0,shrink=1,note=null;
    if(ri.gap<=4){pen+=0.10;note=`短休上陣(僅休 ${ri.gap-1} 天)`;}
    if(ri.pit!=null&&ri.pit>=105){pen+=0.05;note=(note?note+'且':'')+`上場投 ${ri.pit} 球負荷重`;}
    if(ri.gap>=11){shrink=0.7;note=`距上次登板 ${ri.gap} 天(復出戰,不確定性高)`;}
    return {pen:Math.min(0.15,pen),shrink,note};
  };
  const raH=restAdj(hStV),raA=restAdj(aStV);
  if(raH.pen)expAway+=raH.pen;
  if(raA.pen)expHome+=raA.pen;
  const ipScale=st2=>{
    const e=(st2&&Number.isFinite(st2.ipStart))?st2.ipStart:5.2;
    return {st:Math.max(.75,Math.min(1.25,e/5.2)),bp:Math.max(.75,Math.min(1.25,(9-e)/3.8))};
  };
  const scH=ipScale(hStV),scA=ipScale(aStV);
  const FT={};
  const stEffH=(dHome!=null)?dHome*stW*scH.st*raH.shrink:0;
  const stEffA=(dAway!=null)?dAway*stW*scA.st*raA.shrink:0;
  expAway+=stEffH;expHome+=stEffA;
  FT.stH=stEffH;FT.stA=stEffA;
  const lgBp=ex?.lgBpEra;
  const bpAdj=t=>{
    const bp=exm[t]?.bpEra;
    if(!(lgBp&&isFinite(bp)))return null;
    return Math.max(-0.5,Math.min(0.5,(bp-lgBp)/9*3.2*0.6));
  };
  const bpH=bpAdj(g.homeId),bpA=bpAdj(g.awayId);
  const bpEffH=(bpH!=null)?bpH*bpW*scH.bp:0;
  const bpEffA=(bpA!=null)?bpA*bpW*scA.bp:0;
  expAway+=bpEffH;expHome+=bpEffA;
  FT.bp=bpEffA-bpEffH;
  const pf=PARK_F[g.homeId]||1;
  if(pf!==1){expHome*=pf;expAway*=pf;}
  FT.wx=0;
  if(Number.isFinite(g.wxTemp)){
    const wxAdj=Math.max(-0.5,Math.min(0.5,0.023*(g.wxTemp-21)));
    expHome+=wxAdj/2;expAway+=wxAdj/2;
    FT.wx=wxAdj;
  }
  FT.h2h=0;
  if(g._h2h&&(g._h2h.a+g._h2h.h)>=4){
    const n2=g._h2h.a+g._h2h.h;
    const diff=(g._h2h.h-g._h2h.a)/n2;
    const h2hAdj=Math.max(-0.25,Math.min(0.25,diff*(n2/(n2+12))*0.5));
    expHome+=h2hAdj/2;expAway-=h2hAdj/2;
    FT.h2h=h2hAdj;
  }
  FT.bias=0;
  if(teamBias){
    let b=(teamBias[g.home]||0)-(teamBias[g.away]||0);
    b=Math.max(-0.55,Math.min(0.55,b));
    expHome+=b/2;expAway-=b/2;
    FT.bias=b;
  }
  FT.luH=+(luH-1).toFixed(3);FT.luA=+(luA-1).toFixed(3);
  const fArr=[FT.stH,FT.stA,FT.bp,FT.bias,FT.h2h,FT.wx,FT.luH,FT.luA].map(v=>+(v||0).toFixed(2));
  return {mPre:expHome-expAway,expHome,expAway,tot:expHome+expAway,f:fArr};
}
const sigScaleOf=t=>Math.max(.90,Math.min(1.10,Math.pow((t||8.6)/8.6,0.35)));
function classifyMiss(g,p,K,SIG){
  const favHome=(p.mPre||0)>=0;
  const prob=Math.max(.05,Math.min(.95,normCdf(p.mPre*K/(SIG*sigScaleOf(p.tot)))));
  const conf=Math.max(prob,1-prob);
  const hR=g.homeScore??0,aR=g.awayScore??0;
  const mid=(p.expHome+p.expAway)/2,half=p.mPre/2*K;
  const eH=mid+half,eA=mid-half;
  const favR=favHome?hR:aR,dogR=favHome?aR:hR;
  const favExp=favHome?eH:eA,dogExp=favHome?eA:eH;
  if(conf<0.58)return 'coin';
  if(g.inns&&g.inns.length>=6){
    let a6=0,h6=0;for(let i=0;i<6;i++){a6+=g.inns[i]?.a||0;h6+=g.inns[i]?.h||0;}
    if((favHome?(h6-a6):(a6-h6))>0)return 'late';
  }
  if(dogR>=dogExp+3)return 'shell';
  if(favR<=favExp-2.5)return 'cold';
  return 'edge';
}

/* ---------- 主流程 ---------- */
(async()=>{
  const today=etToday(),yesterday=shiftDate(today,-1);
  const season=+today.slice(0,4);
  let state={sigma:4.3,k:1.0,hist:[],ledger:[],last:null};
  try{state=Object.assign(state,JSON.parse(fs.readFileSync(FILE,'utf8')));}catch(e){console.log('無現存 calib.json,首次建立');}
  let start=state.last?shiftDate(state.last,1):shiftDate(yesterday,-(BOOTSTRAP_DAYS-1));
  if(start>yesterday){console.log('無新日期需處理');}
  const ex=await fetchTeamExtras(season,yesterday);
  const teamBias=computeTeamBias(state.ledger,state.k);
  console.log('球隊偏差校正:',Object.keys(teamBias).length,'隊納入');
  // 自我調權:近30天未中歸因 vs 整季基準 → 微調層權重(步伐0.02,範圍0.85-1.20,無訊號時緩慢歸位)
  state.tune=state.tune||{stW:1,bpW:1};
  if(state.tune.luW==null)state.tune.luW=1;
  {
    const Lv=state.ledger.filter(x=>x.m!=null&&x.am!=null);
    const dsAll=[...new Set(Lv.map(x=>x.d))].sort();
    const cut30=dsAll[Math.max(0,dsAll.length-30)];
    const R=Lv.filter(x=>x.d>=cut30), G=Lv;
    const rate=(arr,cat)=>arr.length?arr.filter(x=>x.cat===cat).length/arr.length:0;
    const step=(w,recent,base)=>{
      if(recent>base*1.35&&recent-base>0.01)w=Math.min(1.20,w+0.02);      // 該類系統性偏多 → 加重
      else if(recent<base*0.7)w=Math.max(0.85,w-0.02);                    // 明顯偏少 → 減輕
      else w=w>1?Math.max(1,w-0.01):(w<1?Math.min(1,w+0.01):w);           // 無訊號 → 緩慢歸位
      return Math.round(w*100)/100;
    };
    state.tune.stW=step(state.tune.stW,rate(R,'shell'),rate(G,'shell'));
    state.tune.bpW=step(state.tune.bpW,rate(R,'late'),rate(G,'late'));
    state.tune.luW=step(state.tune.luW,rate(R,'cold'),rate(G,'cold'));
    console.log(`自我調權(依近30天歸因):先發層×${state.tune.stW} 牛棚層×${state.tune.bpW} 名單層×${state.tune.luW}`+
      `(shell ${(rate(R,'shell')*100).toFixed(1)}%/${(rate(G,'shell')*100).toFixed(1)}%、late ${(rate(R,'late')*100).toFixed(1)}%/${(rate(G,'late')*100).toFixed(1)}%、cold ${(rate(R,'cold')*100).toFixed(1)}%/${(rate(G,'cold')*100).toFixed(1)}%)`);
  }
  const seen=new Set(state.ledger.map(x=>x.id));
  let dates=[];for(let d=start;d<=yesterday;d=shiftDate(d,1))dates.push(d);
  console.log(`處理 ${dates.length} 天:${start} → ${yesterday}`);
  for(const date of dates){
    try{
      const asOf=shiftDate(date,-1);
      const [pm,games,fat]=await Promise.all([fetchStandingsAsOf(asOf),fetchGames(date),bpFatigue(date)]);
      const lg=leagueRPG(pm);
      const pitIds=[...new Set(games.flatMap(g=>[g.awayPitId,g.homePitId]).filter(Boolean))];
      const ps=await fetchPitcherStats(pitIds,season,asOf);
      const ex2=Object.assign({},ex,{fatigue:fat});
      let added=0;
      for(const g of games){
        if(g.status!=='Final')continue;
        if(/postpon|suspend|cancel/i.test(g.detail||''))continue;
        const homeWon=g.homeWin?true:(g.awayWin?false:null);if(homeWon==null)continue;
        if(seen.has(g.id))continue;
        const lu=await fetchLineupRatio(g,ex.map||{},asOf);
        if(lu){g.luA=lu.a;g.luH=lu.h;g.luSp=lu.sp;}
        const wt=await fetchWxTemp(g.homeId,g.ts);
        if(Number.isFinite(wt))g.wxTemp=wt;
        const hh=await fetchH2H(g,season,date);
        if(hh)g._h2h=hh;
        const p=predict(g,pm,lg,ps,ex2,teamBias,state.tune);if(!p)continue;
        const hit=((p.mPre>=0)===homeWon)?1:0;
        state.ledger.push({id:g.id,d:date,aw:g.away,hm:g.home,
          m:+p.mPre.toFixed(2),am:(g.homeScore??0)-(g.awayScore??0),hit,
          t:+p.tot.toFixed(1),f:p.f,
          cat:hit?undefined:classifyMiss(g,p,state.k,state.sigma)});
        seen.add(g.id);added++;
      }
      console.log(`${date}: +${added} 場`);
    }catch(e){console.log(`${date}: 跳過(${e.message})`);}
  }
  // 整季保留(球季 3/15 起),依日期排序
  const keep=`${season}-03-15`;
  state.ledger=state.ledger.filter(x=>x.d>=keep).sort((a,b)=>a.d.localeCompare(b.d));
  // 擬合:近 FIT_DAYS 天
  const fitStart=shiftDate(yesterday,-(FIT_DAYS-1));
  const sub=state.ledger.filter(x=>x.d>=fitStart);
  if(sub.length>=100){
    let num=0,den=0;sub.forEach(x=>{num+=x.m*x.am;den+=x.m*x.m;});
    if(den>1e-6){
      let raw=Math.max(0.6,Math.min(1.6,num/den));
      state.k=Math.max(0.7,Math.min(1.4,Math.round((state.k+(raw-state.k)*0.5)*100)/100));
    }
    const brier=(s,k)=>sub.reduce((t,x)=>{
      const p=Math.max(.05,Math.min(.95,normCdf(x.m*k/(s*sigScaleOf(x.t)))));
      const won=(x.m>=0)?(x.hit===1):(x.hit===0); // hit=看好方是否贏;主隊視角:
      const homeWon=(x.m>=0)===(x.hit===1);
      return t+Math.pow(p-(homeWon?1:0),2);},0)/sub.length;
    let bestS=state.sigma,bestB=brier(state.sigma,state.k);
    for(let s=3.0;s<=6.75;s+=0.25){const b=brier(s,state.k);if(b<bestB-1e-9){bestB=b;bestS=s;}}
    if(Math.abs(bestS-state.sigma)>0.01)
      state.sigma=Math.round((state.sigma+(bestS-state.sigma)*0.5)*4)/4;
    const hit=sub.filter(x=>x.hit===1).length/sub.length;
    const errs=sub.map(x=>Math.abs(x.am-x.m*state.k));
    const e=errs.reduce((a,b)=>a+b,0)/errs.length;
    const h2=errs.filter(v=>v<=2).length/errs.length;
    state.hist.push({d:today,s:state.sigma,k:state.k,
      hit:+(hit*100).toFixed(1),e:+e.toFixed(2),h2:+(h2*100).toFixed(1),n:sub.length});
    while(state.hist.length>120)state.hist.shift();
    console.log(`擬合完成(${sub.length} 場/${FIT_DAYS}天):K=${state.k} σ=${state.sigma} 命中 ${(hit*100).toFixed(1)}% 分差誤差 ${e.toFixed(2)} ±2命中 ${(h2*100).toFixed(1)}%`);
  }else{
    console.log(`樣本不足(${sub.length}),僅累積不調參`);
  }
  state.last=yesterday;
  state.updated=new Date().toISOString();
  state.window=FIT_DAYS;
  fs.writeFileSync(FILE,JSON.stringify(state));
  console.log(`寫入 ${FILE}:紀錄簿 ${state.ledger.length} 場、履歷 ${state.hist.length} 筆`);
})().catch(e=>{console.error('校準失敗:',e);process.exit(1);});
