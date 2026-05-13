// netlify/functions/quotes.mjs
// Yahoo Finance quote proxy — serverside, geen CORS
// Speciale cookie-handling voor Europese aandelen (AKA.BR, SOF.BR, IFX.DE)

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Haal een Yahoo Finance sessie-cookie op
async function getYahooCookie() {
  try {
    // Probeer eerst de consent-vrije API
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(5000),
    });
    const cookies1 = r1.headers.get('set-cookie') || '';
    const m1 = cookies1.match(/A1=([^;]+)/);
    if (m1) return `A1=${m1[1]}`;

    // Fallback: finance.yahoo.com homepage
    const r2 = await fetch('https://finance.yahoo.com/', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
      signal: AbortSignal.timeout(6000),
    });
    const cookies2 = r2.headers.get('set-cookie') || '';
    const m2 = cookies2.match(/A1=([^;]+)/);
    if (m2) return `A1=${m2[1]}`;
  } catch(e) {}
  return '';
}

// Fetch één symbool via Yahoo Finance quoteSummary
async function fetchSymbol(sym, cookie) {
  const base = encodeURIComponent(sym);
  const modules = 'price,financialData,defaultKeyStatistics,recommendationTrend';
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
  };
  if (cookie) headers['Cookie'] = cookie;

  // Probeer query1 dan query2
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${base}?modules=${modules}&ssl=true&crumb=`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const json = await r.json();
      const result = json?.quoteSummary?.result?.[0];
      if (result) return result;
    } catch(e) {}
  }

  // Laatste poging: v8 chart endpoint (geeft basisinfo terug)
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${base}?interval=1d&range=1d`;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const json = await r.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        return { _fromChart: true, meta };
      }
    }
  } catch(e) {}

  throw new Error(`Geen data voor ${sym}`);
}

function processResult(sym, result) {
  // Resultaat uit chart-fallback
  if (result._fromChart) {
    const m = result.meta;
    return {
      price:    m.regularMarketPrice,
      chgAbs:   m.regularMarketPrice - m.chartPreviousClose,
      chgPct:   +((m.regularMarketPrice - m.chartPreviousClose) / m.chartPreviousClose * 100).toFixed(4),
      wkHigh:   m.fiftyTwoWeekHigh,
      wkLow:    m.fiftyTwoWeekLow,
      currency: m.currency,
      name:     sym,
      exchange: m.exchangeName,
      dayHigh:  m.regularMarketDayHigh,
      dayLow:   m.regularMarketDayLow,
      prevClose:m.chartPreviousClose,
    };
  }

  const p  = result.price                || {};
  const fd = result.financialData         || {};
  const ks = result.defaultKeyStatistics  || {};
  const rt = result.recommendationTrend?.trend?.[0] || {};
  const price = p.regularMarketPrice?.raw;

  return {
    price,
    chgAbs:      p.regularMarketChange?.raw ?? 0,
    chgPct:      +((p.regularMarketChangePercent?.raw ?? 0) * 100).toFixed(4),
    prevClose:   p.regularMarketPreviousClose?.raw,
    dayHigh:     p.regularMarketDayHigh?.raw,
    dayLow:      p.regularMarketDayLow?.raw,
    wkHigh:      p.fiftyTwoWeekHigh?.raw,
    wkLow:       p.fiftyTwoWeekLow?.raw,
    currency:    p.currency,
    name:        p.shortName || p.longName,
    exchange:    p.exchangeName,
    mktCap:      p.marketCap?.raw,
    // Ratios
    pe:          ks.trailingEps?.raw && price ? +(price / ks.trailingEps.raw).toFixed(1) : null,
    forwardPE:   ks.forwardPE?.raw   ? +ks.forwardPE.raw.toFixed(1)  : null,
    beta:        ks.beta?.raw        ? +ks.beta.raw.toFixed(2)       : null,
    divYield:    ks.dividendYield?.raw ? +(ks.dividendYield.raw*100).toFixed(2) : null,
    grossMargin: fd.grossMargins?.raw  ? +(fd.grossMargins.raw*100).toFixed(1)  : null,
    profitMargin:fd.profitMargins?.raw ? +(fd.profitMargins.raw*100).toFixed(1) : null,
    roe:         fd.returnOnEquity?.raw ? +(fd.returnOnEquity.raw*100).toFixed(1): null,
    // Analyst
    targetLow:   fd.targetLowPrice?.raw,
    targetMean:  fd.targetMeanPrice?.raw,
    targetHigh:  fd.targetHighPrice?.raw,
    numAnalysts: fd.numberOfAnalystOpinions?.raw,
    recKey:      fd.recommendationKey,
    strongBuy:   rt.strongBuy  ?? 0,
    buy:         rt.buy        ?? 0,
    hold:        rt.hold       ?? 0,
    sell:        rt.sell       ?? 0,
    strongSell:  rt.strongSell ?? 0,
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

  // Één cookie voor alle requests
  const cookie = await getYahooCookie();

  const results = {};

  await Promise.allSettled(symbols.map(async sym => {
    try {
      const raw = await fetchSymbol(sym, cookie);
      results[sym] = processResult(sym, raw);
    } catch(e) {
      results[sym] = { error: e.message };
      console.error(`Quote error ${sym}:`, e.message);
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
