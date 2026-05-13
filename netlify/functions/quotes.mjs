// netlify/functions/quotes.mjs
// Serverside Yahoo Finance proxy — geen CORS, werkt voor US én Europese aandelen

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
      body: '',
    };
  }

  const symbols = (event.queryStringParameters?.symbols || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (!symbols.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Geen symbolen' }) };
  }

  // Cookie ophalen — nodig voor Europese aandelen op Yahoo
  let cookie = '';
  try {
    const cr = await fetch('https://finance.yahoo.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    const sc = cr.headers.get('set-cookie') || '';
    const m = sc.match(/A1=([^;]+)/);
    if (m) cookie = `A1=${m[1]}`;
  } catch(e) { /* doorgaan zonder cookie */ }

  const results = {};

  await Promise.allSettled(symbols.map(async (sym) => {
    try {
      const base = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=price,financialData,defaultKeyStatistics,recommendationTrend&ssl=true`;
      const hdrs = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
      };
      if (cookie) hdrs['Cookie'] = cookie;

      let res = await fetch(base, { headers: hdrs });
      if (!res.ok) {
        // Fallback naar query2
        res = await fetch(base.replace('query1', 'query2'), { headers: hdrs });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const r = data?.quoteSummary?.result?.[0];
      if (!r) throw new Error('Geen resultaat');

      const p  = r.price || {};
      const fd = r.financialData || {};
      const ks = r.defaultKeyStatistics || {};
      const rt = r.recommendationTrend?.trend?.[0] || {};
      const price = p.regularMarketPrice?.raw;

      results[sym] = {
        price,
        chgAbs:   p.regularMarketChange?.raw ?? 0,
        chgPct:   +((p.regularMarketChangePercent?.raw ?? 0) * 100).toFixed(4),
        prevClose: p.regularMarketPreviousClose?.raw,
        dayHigh:  p.regularMarketDayHigh?.raw,
        dayLow:   p.regularMarketDayLow?.raw,
        wkHigh:   p.fiftyTwoWeekHigh?.raw,
        wkLow:    p.fiftyTwoWeekLow?.raw,
        currency: p.currency,
        name:     p.shortName || p.longName,
        exchange: p.exchangeName,
        mktCap:   p.marketCap?.raw,
        // Ratio's
        pe:           ks.trailingEps?.raw && price ? +(price/ks.trailingEps.raw).toFixed(1) : null,
        forwardPE:    ks.forwardPE?.raw    ? +ks.forwardPE.raw.toFixed(1) : null,
        beta:         ks.beta?.raw         ? +ks.beta.raw.toFixed(2) : null,
        divYield:     ks.dividendYield?.raw ? +(ks.dividendYield.raw*100).toFixed(2) : null,
        grossMargin:  fd.grossMargins?.raw  ? +(fd.grossMargins.raw*100).toFixed(1) : null,
        profitMargin: fd.profitMargins?.raw ? +(fd.profitMargins.raw*100).toFixed(1) : null,
        roe:          fd.returnOnEquity?.raw ? +(fd.returnOnEquity.raw*100).toFixed(1) : null,
        // Analisten
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
    } catch(e) {
      results[sym] = { error: e.message };
    }
  }));

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=180',
    },
    body: JSON.stringify(results),
  };
}
