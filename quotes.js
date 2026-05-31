// functions/news.js — Cloudflare Pages Function
const FH_KEY = 'd81im41r01qrojfbo940d81im41r01qrojfbo94g';

const CORS = { 'Access-Control-Allow-Origin':'*', 'Content-Type':'application/json' };

const FH_SYM = {
  'AAPL':'AAPL','GOOGL':'GOOGL','ACKB':'AKA','SOF':'SOF','IFX':'IFX',
  'AKA.BR':'AKA','SOF.BR':'SOF','IFX.DE':'IFX','ASML.AS':'ASML',
};

function parseRSS(xml, source, limit=8) {
  const items=[], re=/<item>([\s\S]*?)<\/item>/g; let m;
  while((m=re.exec(xml))&&items.length<limit){
    const s=m[1];
    const g=tag=>{
      const r=new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
      const x=r.exec(s); return x?(x[1]||x[2]||'').trim():'';
    };
    const title=g('title').replace(/<[^>]+>/g,'');
    const link=g('link')||g('guid');
    const pub=g('pubDate');
    const desc=g('description').replace(/<[^>]+>/g,'').slice(0,300);
    if(title&&link) items.push({source,title,url:link,summary:desc,
      publishedAt:pub?Math.floor(new Date(pub).getTime()/1000):Math.floor(Date.now()/1000)});
  }
  return items;
}

async function rss(url, source, limit=8) {
  try {
    const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0','Accept':'application/rss+xml,text/xml'}});
    if(!r.ok) return [];
    return parseRSS(await r.text(), source, limit);
  } catch(e){ return []; }
}

async function finnhubNews(sym) {
  try {
    const fhSym=FH_SYM[sym]||sym.split('.')[0];
    const to=new Date(), from=new Date(to-30*864e5);
    const url=`https://finnhub.io/api/v1/company-news?symbol=${fhSym}&from=${from.toISOString().split('T')[0]}&to=${to.toISOString().split('T')[0]}&token=${FH_KEY}`;
    const r=await fetch(url);
    if(!r.ok) return [];
    const data=await r.json();
    return (Array.isArray(data)?data:[]).slice(0,12).map(n=>({
      source:n.source||'Finnhub',title:n.headline,url:n.url,
      summary:(n.summary||'').slice(0,300),publishedAt:n.datetime,
    })).filter(n=>n.title&&n.url);
  } catch(e){ return []; }
}

async function upgrades(sym) {
  try {
    const fhSym=FH_SYM[sym]||sym.split('.')[0];
    const r=await fetch(`https://finnhub.io/api/v1/stock/upgrade-downgrade?symbol=${fhSym}&token=${FH_KEY}`);
    if(!r.ok) return [];
    const data=await r.json();
    return (Array.isArray(data)?data:[]).sort((a,b)=>new Date(b.gradeDate)-new Date(a.gradeDate)).slice(0,10).map(u=>({
      gradeDate:u.gradeDate,firm:u.company,action:u.action,fromGrade:u.fromGrade,toGrade:u.toGrade,
      actionNl:u.action==='upgrade'?'↑ Upgrade':u.action==='downgrade'?'↓ Downgrade':u.action==='initiated'?'★ Initiatie':'→ Bevestigd',
      sentiment:u.action==='upgrade'||u.action==='initiated'?'positive':u.action==='downgrade'?'negative':'neutral',
    }));
  } catch(e){ return []; }
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method==='OPTIONS') return new Response('',{headers:CORS});
  const url=new URL(request.url);
  const sym=url.searchParams.get('symbol')||'';
  const name=url.searchParams.get('name')||sym;
  if(!sym) return new Response(JSON.stringify({error:'Geen symbool'}),{status:400,headers:CORS});

  const isBE=/\.(BR|AS|DE|PA)$/.test(sym);
  const [fhN, gNews, lecho, up] = await Promise.all([
    finnhubNews(sym),
    rss(`https://news.google.com/rss/search?q=${encodeURIComponent(name+(isBE?' beurs':'  stock'))}&hl=${isBE?'nl':'en'}&gl=${isBE?'BE':'US'}&ceid=${isBE?'BE:nl':'US:en'}`,'Google News',8),
    isBE?rss('https://www.lecho.be/rss/top_stories.xml',"L'Echo",5):Promise.resolve([]),
    upgrades(sym),
  ]);

  const allNews=[...fhN,...(isBE?lecho:[]),...gNews];
  const seen=new Set();
  const dedup=allNews.filter(n=>{const k=(n.title||'').slice(0,60).toLowerCase().replace(/\s+/g,'');if(seen.has(k))return false;seen.add(k);return true;})
    .sort((a,b)=>b.publishedAt-a.publishedAt).slice(0,20);

  return new Response(JSON.stringify({news:dedup,upgrades:up}),{
    headers:{...CORS,'Cache-Control':'public, max-age=300'}
  });
}
