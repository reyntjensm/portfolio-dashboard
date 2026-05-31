// functions/history.js — Cloudflare Pages Function

const AV_KEY  = 'YV7LYG7RHI1SPAS6';
const TD_KEY  = '';
const AV_BASE = 'https://www.alphavantage.co/query';
const TD_BASE = 'https://api.twelvedata.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

const AV_SYM = {
  ACKB:'AKA.BRU', SOF:'SOF.BRU', IFX:'IFX.DEX',
  'AKA.BR':'AKA.BRU', 'SOF.BR':'SOF.BRU', 'IFX.DE':'IFX.DEX',
  'KBC.BR':'KBC.BRU', 'UCB.BR':'UCB.BRU', 'ASML.AS':'ASML.AMS',
};
const TD_US = { AAPL:'AAPL', GOOGL:'GOOGL', NVDA:'NVDA', MSFT:'MSFT' };

const AV_CFG = {
  '15M':{ func:'TIME_SERIES_INTRADAY', interval:'15min', outputsize:'compact', days:1   },
  '1U': { func:'TIME_SERIES_INTRADAY', interval:'60min', outputsize:'full',    days:5   },
  '1M': { func:'TIME_SERIES_DAILY',    outputsize:'compact',                   days:30  },
  '3M': { func:'TIME_SERIES_DAILY',    outputsize:'full',                      days:90  },
  '6M': { func:'TIME_SERIES_DAILY',    outputsize:'full',                      days:180 },
  '1J': { func:'TIME_SERIES_DAILY',    outputsize:'full',                      days:365 },
  '2J': { func:'TIME_SERIES_WEEKLY',   outputsize:'full',                      days:730 },
  '5J': { func:'TIME_SERIES_WEEKLY',   outputsize:'full',                      days:1825},
  'MAX':{ func:'TIME_SERIES_MONTHLY',  outputsize:'full',                      days:9999},
};

const TD_CFG = {
  '15M':{ interval:'15min', outputsize:96  },
  '1U': { interval:'1h',    outputsize:120 },
  '1M': { interval:'1day',  outputsize:30  },
  '3M': { interval:'1day',  outputsize:90  },
  '6M': { interval:'1day',  outputsize:180 },
  '1J': { interval:'1day',  outputsize:365 },
  '2J': { interval:'1week', outputsize:104 },
  '5J': { interval:'1week', outputsize:260 },
  'MAX':{ interval:'1month',outputsize:120 },
};

async function fromAV(avSym, period) {
  const cfg = AV_CFG[period] || AV_CFG['1J'];
  const params = new URLSearchParams({
    function: cfg.func, symbol: avSym,
    outputsize: cfg.outputsize || 'full', apikey: AV_KEY,
  });
  if (cfg.interval) params.set('interval', cfg.interval);

  const r    = await fetch(`${AV_BASE}?${params}`);
  if (!r.ok) throw new Error(`AV HTTP ${r.status}`);
  const data = await r.json();
  if (data.Note || data.Information) throw new Error('Alpha Vantage rate limit');

  const key = Object.keys(data).find(k => k.startsWith('Time Series'));
  if (!key) throw new Error(`Geen AV data voor ${avSym}`);

  const cutoff = new Date(Date.now() - cfg.days * 864e5);
  return Object.entries(data[key])
    .map(([dt, v]) => ({
      t: new Date(dt).getTime(),
      o: parseFloat(v['1. open']),  h: parseFloat(v['2. high']),
      l: parseFloat(v['3. low']),   c: parseFloat(v['4. close']),
      v: parseInt(v['5. volume'] || '0'),
    }))
    .filter(c => !isNaN(c.c) && c.c > 0 && new Date(c.t) >= cutoff)
    .sort((a, b) => a.t - b.t);
}

async function fromTD(sym, period) {
  if (!TD_KEY) throw new Error('Geen TD key');
  const cfg = TD_CFG[period] || TD_CFG['1J'];
  const r   = await fetch(
    `${TD_BASE}/time_series?symbol=${sym}&interval=${cfg.interval}&outputsize=${cfg.outputsize}&order=ASC&apikey=${TD_KEY}`
  );
  if (!r.ok) throw new Error(`TD HTTP ${r.status}`);
  const d = await r.json();
  if (d.status === 'error') throw new Error(d.message);
  return (d.values||[]).map(v=>({
    t:new Date(v.datetime+'Z').getTime(),
    o:parseFloat(v.open), h:parseFloat(v.high),
    l:parseFloat(v.low),  c:parseFloat(v.close),
    v:parseInt(v.volume||'0'),
  })).filter(c=>!isNaN(c.c)&&c.c>0);
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response('', { headers: CORS });

  const url    = new URL(request.url);
  const sym    = url.searchParams.get('symbol') || '';
  const period = url.searchParams.get('period') || '1J';
  if (!sym) return new Response(JSON.stringify({error:'Geen symbool'}), {status:400, headers:CORS});

  const avSym = AV_SYM[sym];
  const tdSym = TD_US[sym];

  try {
    let candles, currency;

    if (avSym) {
      candles = await fromAV(avSym, period);
      currency = 'EUR';
    } else if (tdSym && TD_KEY) {
      candles = await fromTD(tdSym, period);
      currency = 'USD';
    } else {
      // US via AV als fallback
      candles = await fromAV(sym, period);
      currency = 'USD';
    }

    if (!candles.length) throw new Error('Geen historische data');

    return new Response(JSON.stringify({ symbol:sym, currency, candles }), {
      headers: { ...CORS, 'Cache-Control': 'public, max-age=300' }
    });
  } catch(e) {
    return new Response(JSON.stringify({error:e.message}), {status:500, headers:CORS});
  }
}
