// netlify/functions/quotes.mjs
// Koersen via Yahoo Finance (serverside — geen CORS probleem)
// + Finnhub als extra voor US stocks

const FH_KEY = 'd81im41r01qrojfbo940d81im41r01qrojfbo94g';

// Yahoo Finance symbolen per portfolio ticker
const YF_SYM = {
  'AAPL':  'AAPL',
  'GOOGL': 'GOOGL',
  'ACKB':  'AKA.BR',
  'SOF':   'SOF.BR',
  'IFX':   'IFX.DE',
};

function resolveYF(sym) {
  if (YF_SYM[sym]) return YF_SYM[sym];
  // Al in Yahoo formaat (watchlist)
  return sym;
}

async function getYahooCookie() {
  try {
    const r = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(5000),
    });
    const sc = r.headers.get('set-cookie') || '';
    const m  = sc.match(/A1=([^;]+)/);
    if (m) return `A1=${m[1]}`;
  } catch(e) {}
  // Fallback
  try {
    const r = await fetch('https://finance.yahoo.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(5000),
    });
    const sc = r.headers.get('set-cookie') || '';
    const m  = sc.match(/A1=([^;]+)/);
    if (m) return `A1=${m[1]}`;
  } catch(e) {}
  return '';
}

async function fetchYahoo(yfSym, cookie) {
  const hdrs = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
  };
  if (cookie) hdrs['Cookie'] = cookie;

  // Probeer v8 chart endpoint — meest betrouwbaar, werkt voor EU aandelen
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=1d&range=1d&includePrePost=false`;
      const r   = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const data = await r.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        const price    = meta.regularMarketPrice;
        const prev     = meta.chartPreviousClose || meta.previousClose || price;
        const chgAbs   = price - prev;
        const chgPct   = prev ? (chgAbs / prev * 100) : 0;
        const currency = meta.currency || (yfSym.endsWith('.BR') || yfSym.endsWith('.DE') ? 'EUR' : 'USD');
        return {
          price, currency,
          chgAbs: +chgAbs.toFixed(4),
          chgPct: +chgPct.toFixed(4),
          prevClose: prev,
          dayHigh:   meta.regularMarketDayHigh  || null,
          dayLow:    meta.regularMarketDayLow   || null,
          wkHigh:    meta.fiftyTwoWeekHigh      || null,
          wkLow:     meta.fiftyTwoWeekLow       || null,
          name:      meta.shortName || meta.symbol || yfSym,
          exchange:  meta.exchangeName || '',
          mktCap: null, pe: null,
          targetLow: null, targetMean: null, targetHigh: null,
          numAnalysts: null, recKey: null,
          strongBuy:0, buy:0, hold:0, sell:0, strongSell:0,
        };
      }
    } catch(e) { console.warn(`Yahoo ${host} ${yfSym}:`, e.message); }
  }
  throw new Error(`Yahoo Finance geeft geen data voor ${yfSym}`);
}

async function fetchFinnhub(sym) {
  const r = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FH_KEY}`,
    { signal: AbortSignal.timeout(6000) }
  );
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  const q = await r.json();
  if (!q.c || q.c === 0) throw new Error('Geen Finnhub data');
  return {
    price: q.c, currency: 'USD',
    chgAbs: +(q.d||0).toFixed(4),
    chgPct: +(q.dp||0).toFixed(4),
    prevClose: q.pc||q.c,
    dayHigh: q.h||null, dayLow: q.l||null,
    wkHigh: null, wkLow: null,
    name: sym, exchange: 'NASDAQ',
    mktCap: null, pe: null,
    targetLow: null, targetMean: null, targetHigh: null,
    numAnalysts: null, recKey: null,
    strongBuy:0, buy:0, hold:0, sell:0, strongSell:0,
  };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode:200, headers:{'Access-Control-Allow-Origin':'*'}, body:'' };
  }

  const symbols = (event.queryStringParameters?.symbols || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) {
    return { statusCode:400, body: JSON.stringify({error:'Geen symbolen'}) };
  }

  // Haal cookie eenmalig op
  const cookie  = await getYahooCookie();
  const results = {};

  await Promise.allSettled(symbols.map(async orig => {
    const yfSym = resolveYF(orig);
    const isEU  = yfSym.endsWith('.BR') || yfSym.endsWith('.DE') || yfSym.endsWith('.AS') || yfSym.endsWith('.PA');

    try {
      if (!isEU) {
        // US: Finnhub primair (real-time), Yahoo als fallback
        try {
          results[orig] = await fetchFinnhub(orig);
          console.log(`✓ Finnhub ${orig}: $${results[orig].price}`);
        } catch(e1) {
          console.warn(`Finnhub ${orig} mislukt: ${e1.message}`);
          results[orig] = await fetchYahoo(yfSym, cookie);
          console.log(`✓ Yahoo ${orig}: $${results[orig].price}`);
        }
      } else {
        // Europees: Yahoo Finance serverside (geen CORS)
        results[orig] = await fetchYahoo(yfSym, cookie);
        console.log(`✓ Yahoo ${orig}: €${results[orig].price}`);
      }
    } catch(e) {
      results[orig] = { error: e.message };
      console.error(`✗ ${orig} (${yfSym}): ${e.message}`);
    }
  }));

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    },
    body: JSON.stringify(results),
  };
}
