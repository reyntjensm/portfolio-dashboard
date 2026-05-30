// netlify/functions/history.mjs
// Twelve Data time series voor grafieken
// Symboolformaat: sym + exchange als aparte parameter (niet sym:EXCHANGE)

const TD_KEY  = process.env.TWELVE_DATA_KEY || '';
const TD_BASE = 'https://api.twelvedata.com';

// Portfolio ticker → { sym, exchange } voor Twelve Data
const TD_CONFIG = {
  'AAPL':    { sym: 'AAPL',  exchange: null       },
  'GOOGL':   { sym: 'GOOGL', exchange: null       },
  'ACKB':    { sym: 'AKA',   exchange: 'Euronext' },
  'SOF':     { sym: 'SOF',   exchange: 'Euronext' },
  'IFX':     { sym: 'IFX',   exchange: 'XETR'    },
  'AKA.BR':  { sym: 'AKA',   exchange: 'Euronext' },
  'SOF.BR':  { sym: 'SOF',   exchange: 'Euronext' },
  'IFX.DE':  { sym: 'IFX',   exchange: 'XETR'    },
  'ASML.AS': { sym: 'ASML',  exchange: 'Euronext' },
  'KBC.BR':  { sym: 'KBC',   exchange: 'Euronext' },
};

function resolveConfig(rawSym) {
  if (TD_CONFIG[rawSym]) return TD_CONFIG[rawSym];
  // Auto-detectie
  if (rawSym.endsWith('.BR')) return { sym: rawSym.replace('.BR',''), exchange: 'Euronext' };
  if (rawSym.endsWith('.DE')) return { sym: rawSym.replace('.DE',''), exchange: 'XETR'    };
  if (rawSym.endsWith('.AS')) return { sym: rawSym.replace('.AS',''), exchange: 'Euronext' };
  if (rawSym.endsWith('.PA')) return { sym: rawSym.replace('.PA',''), exchange: 'Euronext' };
  return { sym: rawSym, exchange: null };
}

// Dashboard period → Twelve Data params
const PERIOD_MAP = {
  '15M': { interval:'15min', outputsize: 96   },
  '1U':  { interval:'15min', outputsize: 480  },
  '1M':  { interval:'1h',    outputsize: 720  },
  '3M':  { interval:'1day',  outputsize: 90   },
  '6M':  { interval:'1day',  outputsize: 180  },
  '1J':  { interval:'1day',  outputsize: 365  },
  '2J':  { interval:'1week', outputsize: 104  },
  '5J':  { interval:'1week', outputsize: 260  },
  'MAX': { interval:'1month',outputsize: 120  },
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode:200, headers:{'Access-Control-Allow-Origin':'*'}, body:'' };
  }

  const rawSym = event.queryStringParameters?.symbol || '';
  const period = event.queryStringParameters?.period || '1J';
  if (!rawSym) return { statusCode:400, body: JSON.stringify({error:'Geen symbool'}) };

  if (!TD_KEY) return { statusCode:500, body: JSON.stringify({error:'Geen Twelve Data key geconfigureerd'}) };

  const { sym, exchange } = resolveConfig(rawSym);
  const { interval, outputsize } = PERIOD_MAP[period] || PERIOD_MAP['1J'];

  // Bouw URL — exchange als aparte param zodat Twelve Data het correct verwerkt
  const params = new URLSearchParams({
    symbol:     sym,
    interval,
    outputsize: outputsize.toString(),
    order:      'ASC',
    apikey:     TD_KEY,
  });
  if (exchange) params.set('exchange', exchange);

  const url = `${TD_BASE}/time_series?${params.toString()}`;
  console.log(`History: ${sym} exchange=${exchange||'US'} period=${period} interval=${interval}`);

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Twelve Data HTTP ${r.status}`);

    const data = await r.json();
    if (data.status === 'error') throw new Error(data.message || 'Twelve Data API fout');

    const values = data.values || [];
    if (!values.length) throw new Error(`Geen historische data voor ${sym}`);

    const candles = values
      .map(v => ({
        t: new Date(v.datetime + (exchange && exchange !== 'US' ? '' : 'Z')).getTime(),
        o: parseFloat(v.open),
        h: parseFloat(v.high),
        l: parseFloat(v.low),
        c: parseFloat(v.close),
        v: parseInt(v.volume || '0'),
      }))
      .filter(c => !isNaN(c.c) && c.c > 0);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': `public, max-age=${interval.includes('min') ? 60 : 300}`,
      },
      body: JSON.stringify({
        symbol:   sym,
        currency: data.meta?.currency || (exchange ? 'EUR' : 'USD'),
        exchange: data.meta?.exchange || exchange || 'US',
        candles,
      }),
    };
  } catch(e) {
    console.error(`History error ${rawSym}:`, e.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' },
      body: JSON.stringify({ error: e.message }),
    };
  }
}
