// netlify/functions/history.mjs
// Historische OHLCV data via Yahoo Finance — van 15m tot ALL TIME

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode:200, headers:{'Access-Control-Allow-Origin':'*'}, body:'' };
  }

  const sym      = event.queryStringParameters?.symbol   || '';
  const period   = event.queryStringParameters?.period   || '1y';
  const interval = event.queryStringParameters?.interval || '1d';

  if (!sym) return { statusCode:400, body: JSON.stringify({error:'Geen symbool'}) };

  // Cookie voor Europese aandelen
  let cookie = '';
  try {
    const cr = await fetch('https://finance.yahoo.com/', {
      headers:{'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'}
    });
    const sc = cr.headers.get('set-cookie')||'';
    const m  = sc.match(/A1=([^;]+)/);
    if (m) cookie = `A1=${m[1]}`;
  } catch(e) {}

  try {
    // Gebruik period2=9999999999 voor maximale data bij 'max' range
    const p2  = period === 'max' ? '9999999999' : Math.floor(Date.now()/1000 + 86400);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=0&period2=${p2}&interval=${interval}&range=${period}&ssl=true&includePrePost=false`;

    const hdrs = {
      'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':'application/json',
      'Referer':'https://finance.yahoo.com/',
    };
    if (cookie) hdrs['Cookie'] = cookie;

    let res = await fetch(url, { headers:hdrs });
    if (!res.ok) res = await fetch(url.replace('query1','query2'), { headers:hdrs });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data  = await res.json();
    const chart = data?.chart?.result?.[0];
    if (!chart) throw new Error('Geen chartdata');

    const ts = chart.timestamp || [];
    const q  = chart.indicators?.quote?.[0] || {};

    const candles = ts.map((t,i) => ({
      t: t * 1000,
      o: q.open?.[i]   != null ? +q.open[i].toFixed(4)   : null,
      h: q.high?.[i]   != null ? +q.high[i].toFixed(4)   : null,
      l: q.low?.[i]    != null ? +q.low[i].toFixed(4)    : null,
      c: q.close?.[i]  != null ? +q.close[i].toFixed(4)  : null,
      v: q.volume?.[i] != null ? Math.round(q.volume[i]) : null,
    })).filter(c => c.c != null);

    return {
      statusCode: 200,
      headers: {
        'Content-Type':'application/json',
        'Access-Control-Allow-Origin':'*',
        'Cache-Control':'public, max-age=60', // 1 min voor intraday, 5 min voor daily
      },
      body: JSON.stringify({
        symbol:   sym,
        currency: chart.meta?.currency,
        exchange: chart.meta?.exchangeName,
        candles,
      }),
    };
  } catch(e) {
    return {
      statusCode: 500,
      headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({error: e.message}),
    };
  }
}
