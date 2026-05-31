// netlify/functions/history.mjs
// Historische koersen via Alpha Vantage (EU) en Twelve Data (US)

const AV_KEY = process.env.ALPHA_VANTAGE_KEY || 'YV7LYG7RHI1SPAS6';
const TD_KEY = process.env.TWELVE_DATA_KEY   || '';
const AV_BASE = 'https://www.alphavantage.co/query';
const TD_BASE = 'https://api.twelvedata.com';

// Symbool mapping
const AV_SYM = {
  ACKB:'AKA.BRU', SOF:'SOF.BRU', IFX:'IFX.DEX',
  'AKA.BR':'AKA.BRU', 'SOF.BR':'SOF.BRU', 'IFX.DE':'IFX.DEX',
  'KBC.BR':'KBC.BRU', 'UCB.BR':'UCB.BRU', 'ASML.AS':'ASML.AMS',
};
const TD_US = { AAPL:'AAPL', GOOGL:'GOOGL', NVDA:'NVDA', MSFT:'MSFT', AMZN:'AMZN' };

// Alpha Vantage function + cutoff per periode
const AV_CFG = {
  '15M': { func:'TIME_SERIES_INTRADAY', interval:'15min', outputsize:'compact', days:1   },
  '1U':  { func:'TIME_SERIES_INTRADAY', interval:'60min', outputsize:'full',    days:5   },
  '1M':  { func:'TIME_SERIES_DAILY',    outputsize:'compact',                   days:30  },
  '3M':  { func:'TIME_SERIES_DAILY',    outputsize:'full',                      days:90  },
  '6M':  { func:'TIME_SERIES_DAILY',    outputsize:'full',                      days:180 },
  '1J':  { func:'TIME_SERIES_DAILY',    outputsize:'full',                      days:365 },
  '2J':  { func:'TIME_SERIES_WEEKLY',   outputsize:'full',                      days:730 },
  '5J':  { func:'TIME_SERIES_WEEKLY',   outputsize:'full',                      days:1825},
  'MAX': { func:'TIME_SERIES_MONTHLY',  outputsize:'full',                      days:9999},
};

const TD_CFG = {
  '15M': { interval:'15min', outputsize:96   },
  '1U':  { interval:'1h',    outputsize:120  },
  '1M':  { interval:'1day',  outputsize:30   },
  '3M':  { interval:'1day',  outputsize:90   },
  '6M':  { interval:'1day',  outputsize:180  },
  '1J':  { interval:'1day',  outputsize:365  },
  '2J':  { interval:'1week', outputsize:104  },
  '5J':  { interval:'1week', outputsize:260  },
  'MAX': { interval:'1month',outputsize:120  },
};

async function fromAV(avSym, period) {
  const cfg = AV_CFG[period] || AV_CFG['1J'];
  const params = new URLSearchParams({
    function:   cfg.func,
    symbol:     avSym,
    outputsize: cfg.outputsize || 'full',
    apikey:     AV_KEY,
  });
  if (cfg.interval) params.set('interval', cfg.interval);

  const r = await fetch(`${AV_BASE}?${params}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`AV HTTP ${r.status}`);
  const data = await r.json();
  if (data.Note || data.Information) throw new Error('Alpha Vantage rate limit bereikt');

  const key = Object.keys(data).find(k => k.startsWith('Time Series'));
  if (!key) throw new Error(`Geen data van Alpha Vantage voor ${avSym}`);

  const cutoff = new Date(Date.now() - cfg.days * 864e5);
  return Object.entries(data[key])
    .map(([dt, v]) => ({
      t: new Date(dt).getTime(),
      o: parseFloat(v['1. open']),
      h: parseFloat(v['2. high']),
      l: parseFloat(v['3. low']),
      c: parseFloat(v['4. close']),
      v: parseInt(v['5. volume'] || '0'),
    }))
    .filter(c => !isNaN(c.c) && c.c > 0 && new Date(c.t) >= cutoff)
    .sort((a, b) => a.t - b.t);
}

async function fromTD(sym, period) {
  if (!TD_KEY) throw new Error('Geen Twelve Data key');
  const cfg = TD_CFG[period] || TD_CFG['1J'];
  const r   = await fetch(
    `${TD_BASE}/time_series?symbol=${sym}&interval=${cfg.interval}&outputsize=${cfg.outputsize}&order=ASC&apikey=${TD_KEY}`,
    { signal: AbortSignal.timeout(20000) }
  );
  if (!r.ok) throw new Error(`TD HTTP ${r.status}`);
  const d = await r.json();
  if (d.status === 'error') throw new Error(d.message || 'Twelve Data fout');
  return (d.values || [])
    .map(v => ({
      t: new Date(v.datetime + 'Z').getTime(),
      o: parseFloat(v.open), h: parseFloat(v.high),
      l: parseFloat(v.low),  c: parseFloat(v.close),
      v: parseInt(v.volume || '0'),
    }))
    .filter(c => !isNaN(c.c) && c.c > 0);
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode:200, headers:{'Access-Control-Allow-Origin':'*'}, body:'' };
  }

  const sym    = event.queryStringParameters?.symbol || '';
  const period = event.queryStringParameters?.period || '1J';
  if (!sym) return { statusCode:400, body: JSON.stringify({error:'Geen symbool'}) };

  const avSym = AV_SYM[sym];
  const tdSym = TD_US[sym];

  try {
    let candles, currency;

    if (avSym) {
      candles  = await fromAV(avSym, period);
      currency = 'EUR';
      console.log(`✓ AV history ${sym}(${avSym}): ${candles.length} candles`);
    } else if (tdSym && TD_KEY) {
      candles  = await fromTD(tdSym, period);
      currency = 'USD';
      console.log(`✓ TD history ${sym}: ${candles.length} candles`);
    } else if (tdSym) {
      // Fallback: AV voor US ook
      candles  = await fromAV(tdSym, period);
      currency = 'USD';
      console.log(`✓ AV history US ${sym}: ${candles.length} candles`);
    } else {
      throw new Error(`Geen configuratie voor symbool: ${sym}`);
    }

    if (!candles.length) throw new Error('Geen historische candles gevonden');

    return {
      statusCode:200,
      headers:{
        'Content-Type':'application/json',
        'Access-Control-Allow-Origin':'*',
        'Cache-Control':'public, max-age=300',
      },
      body: JSON.stringify({ symbol:sym, currency, candles }),
    };
  } catch(e) {
    console.error(`History error ${sym}: ${e.message}`);
    return {
      statusCode:500,
      headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({ error: e.message }),
    };
  }
}
