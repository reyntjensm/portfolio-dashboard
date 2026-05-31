// netlify/functions/history.mjs
// Historische koersen via Yahoo Finance v8 chart API (serverside)
// Werkt voor ACKB (AKA.BR), SOF (SOF.BR), IFX (IFX.DE), AAPL, GOOGL

const YF_SYM = {
  'AAPL':  'AAPL',  'GOOGL': 'GOOGL',
  'ACKB':  'AKA.BR','SOF':   'SOF.BR', 'IFX': 'IFX.DE',
  'AKA.BR':'AKA.BR','SOF.BR':'SOF.BR', 'IFX.DE':'IFX.DE',
  'ASML.AS':'ASML.AS','KBC.BR':'KBC.BR','UCB.BR':'UCB.BR',
};

const PERIOD_MAP = {
  '15M': { range:'1d',  interval:'15m' },
  '1U':  { range:'5d',  interval:'30m' },
  '1M':  { range:'1mo', interval:'1d'  },
  '3M':  { range:'3mo', interval:'1d'  },
  '6M':  { range:'6mo', interval:'1d'  },
  '1J':  { range:'1y',  interval:'1d'  },
  '2J':  { range:'2y',  interval:'1wk' },
  '5J':  { range:'5y',  interval:'1mo' },
  'MAX': { range:'max', interval:'1mo' },
};

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
  return '';
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode:200, headers:{'Access-Control-Allow-Origin':'*'}, body:'' };
  }

  const rawSym = event.queryStringParameters?.symbol || '';
  const period = event.queryStringParameters?.period || '1J';
  if (!rawSym) return { statusCode:400, body: JSON.stringify({error:'Geen symbool'}) };

  const yfSym = YF_SYM[rawSym] || rawSym;
  const { range, interval } = PERIOD_MAP[period] || PERIOD_MAP['1J'];
  const cookie = await getYahooCookie();

  const hdrs = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
  };
  if (cookie) hdrs['Cookie'] = cookie;

  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=${interval}&range=${range}&includePrePost=false`;
      const r   = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;

      const data  = await r.json();
      const chart = data?.chart?.result?.[0];
      if (!chart) continue;

      const ts = chart.timestamp || [];
      const q  = chart.indicators?.quote?.[0] || {};
      const candles = ts.map((t, i) => ({
        t: t * 1000,
        o: q.open?.[i]   != null ? +q.open[i].toFixed(4)   : null,
        h: q.high?.[i]   != null ? +q.high[i].toFixed(4)   : null,
        l: q.low?.[i]    != null ? +q.low[i].toFixed(4)    : null,
        c: q.close?.[i]  != null ? +q.close[i].toFixed(4)  : null,
        v: q.volume?.[i] != null ? Math.round(q.volume[i]) : 0,
      })).filter(c => c.c != null && c.c > 0);

      if (!candles.length) continue;

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': `public, max-age=${interval.includes('m') ? 60 : 300}`,
        },
        body: JSON.stringify({
          symbol:   yfSym,
          currency: chart.meta?.currency || 'EUR',
          exchange: chart.meta?.exchangeName || '',
          candles,
        }),
      };
    } catch(e) {
      console.warn(`History ${host} ${yfSym}:`, e.message);
    }
  }

  return {
    statusCode: 500,
    headers: { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' },
    body: JSON.stringify({ error: `Geen historische data voor ${yfSym}` }),
  };
}
