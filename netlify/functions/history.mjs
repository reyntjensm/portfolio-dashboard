// netlify/functions/history.mjs
// Twelve Data time series voor grafieken
// Accepteert portfolio ticker (ACKB, IFX, ...) OF Yahoo-stijl symbool (AKA.BR, IFX.DE)

const TD_KEY  = process.env.TWELVE_DATA_KEY || 'JOUW_TWELVE_DATA_KEY';
const TD_BASE = 'https://api.twelvedata.com';

// Alle bekende portfolio tickers → Twelve Data symbool
const TD_SYMBOL = {
  // Portfolio tickers
  'AAPL':  'AAPL',
  'GOOGL': 'GOOGL',
  'ACKB':  'AKA:BRU',
  'SOF':   'SOF:BRU',
  'IFX':   'IFX:XETR',
  // Yahoo Finance stijl (fallback)
  'AKA.BR': 'AKA:BRU',
  'SOF.BR': 'SOF:BRU',
  'IFX.DE': 'IFX:XETR',
  'ASML.AS':'ASML:AMS',
  'KBC.BR': 'KBC:BRU',
  'AB.BR':  'ABI:BRU',
};

// Dashboard period code → Twelve Data params
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
  // Fallback voor oudere Yahoo-stijl periodes
  '1d':  { interval:'15min', outputsize: 96   },
  '5d':  { interval:'15min', outputsize: 480  },
  '1mo': { interval:'1h',    outputsize: 720  },
  '3mo': { interval:'1day',  outputsize: 90   },
  '6mo': { interval:'1day',  outputsize: 180  },
  '1y':  { interval:'1day',  outputsize: 365  },
  '2y':  { interval:'1week', outputsize: 104  },
  '5y':  { interval:'1week', outputsize: 260  },
  'max': { interval:'1month',outputsize: 120  },
};

function resolveSymbol(rawSym) {
  // 1. Directe match
  if (TD_SYMBOL[rawSym]) return TD_SYMBOL[rawSym];
  // 2. Automatische conversie van Yahoo-stijl
  if (rawSym.includes('.BR')) return rawSym.replace('.BR', ':BRU');
  if (rawSym.includes('.DE')) return rawSym.replace('.DE', ':XETR');
  if (rawSym.includes('.AS')) return rawSym.replace('.AS', ':AMS');
  if (rawSym.includes('.PA')) return rawSym.replace('.PA', ':PAR');
  if (rawSym.includes('.HE')) return rawSym.replace('.HE', ':HEL');
  // 3. US ticker — geen aanpassing nodig
  return rawSym;
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode:200, headers:{'Access-Control-Allow-Origin':'*'}, body:'' };
  }

  const rawSym = event.queryStringParameters?.symbol || '';
  const period = event.queryStringParameters?.period || '1J';

  if (!rawSym) return { statusCode:400, body: JSON.stringify({error:'Geen symbool'}) };

  const tdSym = resolveSymbol(rawSym);
  const { interval, outputsize } = PERIOD_MAP[period] || PERIOD_MAP['1J'];

  try {
    const url = `${TD_BASE}/time_series?symbol=${encodeURIComponent(tdSym)}&interval=${interval}&outputsize=${outputsize}&apikey=${TD_KEY}&order=ASC`;
    console.log(`History fetch: ${tdSym} period=${period} interval=${interval} outputsize=${outputsize}`);

    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Twelve Data HTTP ${r.status}`);

    const data = await r.json();
    if (data.status === 'error') throw new Error(data.message || 'Twelve Data API fout');

    const values = data.values || [];
    if (!values.length) throw new Error(`Geen historische data voor ${tdSym}`);

    const candles = values
      .map(v => ({
        t: new Date(v.datetime).getTime(),
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
        symbol:   tdSym,
        currency: data.meta?.currency || '',
        exchange: data.meta?.exchange || '',
        candles,
      }),
    };
  } catch(e) {
    console.error(`History error ${rawSym} → ${tdSym}:`, e.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' },
      body: JSON.stringify({ error: `${e.message} (symbool: ${tdSym})` }),
    };
  }
}
