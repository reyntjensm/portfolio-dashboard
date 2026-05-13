// netlify/functions/news.mjs
// Nieuws: Finnhub + Yahoo RSS + Google News BE + L'Echo + Investopedia
// Analisten: Finnhub upgrades/downgrades

const FH_KEY = 'd81im41r01qrojfbo940d81im41r01qrojfbo94g';

const FH_SYM = {
  'AAPL':'AAPL','GOOGL':'GOOGL','MSFT':'MSFT','NVDA':'NVDA','AMZN':'AMZN',
  'AKA.BR':'AKA','SOF.BR':'SOF','IFX.DE':'IFX','ASML.AS':'ASML',
  'UCB.BR':'UCB','AB.BR':'ABI','SOLB.BR':'SOLB','KBC.BR':'KBC',
  'INGA.AS':'ING','PHIA.AS':'PHG','NOKIA.HE':'NOKIA',
};

function parseRSS(xml, source, limit=8) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < limit) {
    const s = m[1];
    const g = tag => {
      const r = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
      const x = r.exec(s);
      return x ? (x[1]||x[2]||'').trim() : '';
    };
    const title = g('title').replace(/<[^>]+>/g,'');
    const link  = g('link')||g('guid');
    const pub   = g('pubDate');
    const desc  = g('description').replace(/<[^>]+>/g,'').slice(0,300);
    if (title && link) items.push({
      source, title, url: link, summary: desc,
      publishedAt: pub ? Math.floor(new Date(pub).getTime()/1000) : Math.floor(Date.now()/1000),
    });
  }
  return items;
}

async function rss(url, source, limit=8) {
  try {
    const r = await fetch(url, {
      headers:{'User-Agent':'Mozilla/5.0','Accept':'application/rss+xml,text/xml'},
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    return parseRSS(await r.text(), source, limit);
  } catch(e) { return []; }
}

// ── News sources ──────────────────────────────────────────────────────────────

async function yahooNews(sym) {
  return rss(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`, 'Yahoo Finance', 10);
}

async function finnhubNews(sym) {
  try {
    const fhSym = FH_SYM[sym] || sym.split('.')[0];
    const to    = new Date(), from = new Date(to - 45*24*60*60*1000);
    const url   = `https://finnhub.io/api/v1/company-news?symbol=${fhSym}&from=${from.toISOString().split('T')[0]}&to=${to.toISOString().split('T')[0]}&token=${FH_KEY}`;
    const res   = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data  = await res.json();
    return (Array.isArray(data)?data:[]).slice(0,12).map(n => ({
      source: n.source||'Finnhub', title: n.headline, url: n.url,
      summary: (n.summary||'').slice(0,300), publishedAt: n.datetime,
    })).filter(n=>n.title&&n.url);
  } catch(e) { return []; }
}

async function googleNews(query, lang='nl', country='BE') {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${lang}&gl=${country}&ceid=${country}:${lang}`;
  return rss(url, 'Google News', 8);
}

async function lechoNews() {
  return rss('https://www.lecho.be/rss/top_stories.xml', "L'Echo", 5);
}

// Investopedia market news — officiële feed via dotdashmeredith CDN
async function investopediaNews() {
  // Probeer meerdere bekende Investopedia RSS endpoints
  const feeds = [
    'https://feeds-api.dotdashmeredith.com/investopedia-site-map.xml', // main
    'https://www.investopedia.com/feedbuilder/feed/getfeed/?feedName=rss_headline', // legacy
  ];
  for (const url of feeds) {
    const items = await rss(url, 'Investopedia', 6);
    if (items.length) return items;
  }
  // Fallback: Google News zoek op Investopedia
  return googleNews('site:investopedia.com stocks investing', 'en', 'US');
}

// Investing.com RSS voor analisten & marktnieuws
async function investingComNews() {
  return rss('https://www.investing.com/rss/news.rss', 'Investing.com', 5);
}

// ── Analyst data ──────────────────────────────────────────────────────────────

async function upgradesDowngrades(sym) {
  try {
    const fhSym = FH_SYM[sym] || sym.split('.')[0];
    const res   = await fetch(`https://finnhub.io/api/v1/stock/upgrade-downgrade?symbol=${fhSym}&token=${FH_KEY}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data  = await res.json();
    return (Array.isArray(data)?data:[])
      .sort((a,b) => new Date(b.gradeDate)-new Date(a.gradeDate))
      .slice(0,12)
      .map(u => ({
        gradeDate: u.gradeDate, firm: u.company, action: u.action,
        fromGrade: u.fromGrade, toGrade: u.toGrade,
        actionNl:  u.action==='upgrade'    ? '↑ Upgrade'
                 : u.action==='downgrade'  ? '↓ Downgrade'
                 : u.action==='initiated'  ? '★ Initiatie'
                 : u.action==='reiterated' ? '→ Herhaald'
                 : '→ Bevestigd',
        sentiment: u.action==='upgrade'||u.action==='initiated' ? 'positive'
                 : u.action==='downgrade' ? 'negative' : 'neutral',
      }));
  } catch(e) { return []; }
}

async function analystData(sym) {
  const fhSym = FH_SYM[sym] || sym.split('.')[0];
  const [target, rec] = await Promise.all([
    fetch(`https://finnhub.io/api/v1/stock/price-target?symbol=${fhSym}&token=${FH_KEY}`, { signal: AbortSignal.timeout(8000) })
      .then(r=>r.ok?r.json():null).catch(()=>null),
    fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${fhSym}&token=${FH_KEY}`, { signal: AbortSignal.timeout(8000) })
      .then(r=>r.ok?r.json():[]).catch(()=>[]),
  ]);
  return { target, recommendations: Array.isArray(rec)?rec.slice(0,4):[] };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:{'Access-Control-Allow-Origin':'*'}, body:'' };

  const sym         = event.queryStringParameters?.symbol || '';
  const companyName = event.queryStringParameters?.name   || sym;
  if (!sym) return { statusCode:400, body: JSON.stringify({error:'Geen symbool'}) };

  const isBelgian = /\.(BR|AS|DE|PA|HE)$/.test(sym);

  // Alle fetches parallel
  const [
    yNews, fhN, gNews, ipNews, icNews,
    lecho, trendsN, upgrades, analyst,
  ] = await Promise.all([
    yahooNews(sym),
    finnhubNews(sym),
    googleNews(companyName + (isBelgian ? ' beurs' : ' stock')),
    investopediaNews(),
    investingComNews(),
    isBelgian ? lechoNews()                  : Promise.resolve([]),
    isBelgian ? googleNews(companyName + ' aandeel beurs', 'nl', 'BE') : Promise.resolve([]),
    upgradesDowngrades(sym),
    analystData(sym),
  ]);

  // Combineer: bedrijfsnieuws eerst, dan marktnieuws/educatie
  const companyNews = isBelgian
    ? [...gNews, ...trendsN, ...lecho, ...fhN, ...yNews]
    : [...fhN, ...gNews, ...yNews];

  // Voeg Investopedia + Investing.com toe als achtergrondbronnen
  const allNews = [...companyNews, ...icNews, ...ipNews];

  const seen = new Set();
  const dedup = allNews.filter(n => {
    const k = (n.title||'').slice(0,60).toLowerCase().replace(/\s+/g,'');
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a,b) => b.publishedAt - a.publishedAt).slice(0,25);

  return {
    statusCode: 200,
    headers: {
      'Content-Type':'application/json',
      'Access-Control-Allow-Origin':'*',
      'Cache-Control':'public, max-age=300',
    },
    body: JSON.stringify({
      news: dedup,
      upgrades,
      analystTarget:   analyst.target,
      recommendations: analyst.recommendations,
    }),
  };
}
