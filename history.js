// functions/analysts.js — Cloudflare Pages Function
const AV_KEY = 'YV7LYG7RHI1SPAS6';
const FH_KEY = 'd81im41r01qrojfbo940d81im41r01qrojfbo94g';
const CORS   = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};

const AV_SYM = { AAPL:'AAPL',GOOGL:'GOOGL',ACKB:'AKA.BRU',SOF:'SOF.BRU',IFX:'IFX.DEX' };
const FH_SYM = { AAPL:'AAPL',GOOGL:'GOOGL',ACKB:'AKA',SOF:'SOF',IFX:'IFX' };

async function avOverview(sym) {
  const avSym=AV_SYM[sym]||sym;
  const r=await fetch(`https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(avSym)}&apikey=${AV_KEY}`);
  if(!r.ok) return null;
  const d=await r.json();
  if(!d.Symbol||d.Note||d.Information) return null;
  return {
    pe:d.PERatio?+parseFloat(d.PERatio).toFixed(1):null,
    forwardPE:d.ForwardPE?+parseFloat(d.ForwardPE).toFixed(1):null,
    beta:d.Beta?+parseFloat(d.Beta).toFixed(2):null,
    divYield:d.DividendYield?+(parseFloat(d.DividendYield)*100).toFixed(2):null,
    roe:d.ReturnOnEquityTTM?+(parseFloat(d.ReturnOnEquityTTM)*100).toFixed(1):null,
    targetPrice:d.AnalystTargetPrice?parseFloat(d.AnalystTargetPrice):null,
    week52High:d['52WeekHigh']?parseFloat(d['52WeekHigh']):null,
    week52Low:d['52WeekLow']?parseFloat(d['52WeekLow']):null,
    analystRating:d.AnalystRatingStrongBuy?{
      strongBuy:parseInt(d.AnalystRatingStrongBuy||'0'),
      buy:parseInt(d.AnalystRatingBuy||'0'),
      hold:parseInt(d.AnalystRatingHold||'0'),
      sell:parseInt(d.AnalystRatingSell||'0'),
      strongSell:parseInt(d.AnalystRatingStrongSell||'0'),
    }:null,
  };
}

async function fhUpgrades(sym) {
  try {
    const fhSym=FH_SYM[sym]||sym.split('.')[0];
    const r=await fetch(`https://finnhub.io/api/v1/stock/upgrade-downgrade?symbol=${fhSym}&token=${FH_KEY}`);
    if(!r.ok) return [];
    const data=await r.json();
    return (Array.isArray(data)?data:[]).sort((a,b)=>new Date(b.gradeDate)-new Date(a.gradeDate)).slice(0,10)
      .map(u=>({gradeDate:u.gradeDate,firm:u.company,action:u.action,fromGrade:u.fromGrade,toGrade:u.toGrade,
        actionNl:u.action==='upgrade'?'↑ Upgrade':u.action==='downgrade'?'↓ Downgrade':u.action==='initiated'?'★ Initiatie':'→ Bevestigd',
        sentiment:u.action==='upgrade'||u.action==='initiated'?'positive':u.action==='downgrade'?'negative':'neutral'}));
  } catch(e){ return []; }
}

async function fhRecommendations(sym) {
  try {
    const fhSym=FH_SYM[sym]||sym.split('.')[0];
    const r=await fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${fhSym}&token=${FH_KEY}`);
    if(!r.ok) return [];
    const d=await r.json();
    return Array.isArray(d)?d.slice(0,4):[];
  } catch(e){ return []; }
}

export async function onRequest(context) {
  const { request }=context;
  if(request.method==='OPTIONS') return new Response('',{headers:CORS});
  const url=new URL(request.url);
  const sym=url.searchParams.get('symbol')||'';
  if(!sym) return new Response(JSON.stringify({error:'Geen symbool'}),{status:400,headers:CORS});

  const [overview,upgrades,recommendations]=await Promise.all([
    avOverview(sym).catch(()=>null),
    fhUpgrades(sym),
    fhRecommendations(sym),
  ]);

  let analystSummary=null;
  if(overview?.analystRating){
    const r=overview.analystRating;
    const buy=r.strongBuy+r.buy, hold=r.hold, sell=r.sell+r.strongSell, total=buy+hold+sell||1;
    analystSummary={buy,hold,sell,total,consensus:buy/total>0.6?'Sterk Kopen':buy/total>0.4?'Kopen':sell/total>0.4?'Verkopen':'Houden',
      avgTarget:overview.targetPrice?Math.round(overview.targetPrice):null,highTarget:null,lowTarget:null};
  } else if(recommendations.length){
    const r0=recommendations[0];
    const buy=(r0.strongBuy||0)+(r0.buy||0),hold=r0.hold||0,sell=(r0.strongSell||0)+(r0.sell||0),total=buy+hold+sell||1;
    analystSummary={buy,hold,sell,total,consensus:buy/total>0.6?'Sterk Kopen':buy/total>0.4?'Kopen':sell/total>0.4?'Verkopen':'Houden',
      avgTarget:null,highTarget:null,lowTarget:null};
  }

  return new Response(JSON.stringify({symbol:sym,overview,upgrades,recommendations,analystSummary}),{
    headers:{...CORS,'Cache-Control':'public, max-age=3600'}
  });
}
