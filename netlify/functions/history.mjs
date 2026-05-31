// netlify/functions/history.mjs
// Alpha Vantage TIME_SERIES voor grafieken (EU stocks)
// + Twelve Data voor US stocks

const AV_KEY  = process.env.ALPHA_VANTAGE_KEY || 'YV7LYG7RHI1SPAS6';
const TD_KEY  = process.env.TWELVE_DATA_KEY   || '';
const AV_BASE = 'https://www.alphavantage.co/query';
const TD_BASE = 'https://api.twelvedata.com';

const AV_SYM = {
  'ACKB': 'AKA.BRU', 'SOF': 'SOF.BRU', 'IFX': 'IFX.DEX',
  'AKA.BR': 'AKA.BRU', 'SOF.BR': 'SOF.BRU', 'IFX.DE': 'IFX.DEX',
  'KBC.BR': 'KBC.BRU', 'UCB.BR': 'UCB.BRU', 'ASML.AS': 'ASML.AMS',
};

const TD_US = { 'AAPL': 'AAPL', 'GOOGL': 'GOOGL', 'NVDA': 'NVDA', 'MSFT': 'MSFT' };

// AV function per periode
function getAVParams(period) {
  switch(period) {
    case '15M': return { func: 'TIME_SERIES_INTRADAY', interval: '15min', slices: 2 };
    case '1U':  return { func: 'TIME_SERIES_INTRADAY', interval: '60min', slices: 5 };
    case '1M':  return { func: 'TIME_SERIES_DAILY',    compact: false };
    case '3M':  return { func: 'TIME_SERIES_DAILY',    compact: false };
    case '6M':  return { func: 'TIME_SERIES_DAILY',    compact: false };
    case '1J':  return { func: 'TIME_SERIES_DAILY',    compact: false };
    case '2J':  return { func: 'TIME_SERIES_WEEKLY' };
    case '5J':  return { func: 'TIME_SERIES_WEEKLY' };
    case 'MAX': return { func: 'TIME_SERIES_MONTHLY' };
    default:    return { func: 'TIME_SERIES_DAILY',    compact: false };
  }
}

const PERIOD_DAYS = {
  '15M':1, '1U':5, '1M':30, '3M':90, '6M':180,
  '1J':365, '2J':730, '5J':1825, 'MAX':9999
};

async function fetchAVHistory(avSym, period) {
  // AV_KEY ingebakken als fallback
  const { func, interval, compact } = getAVParams(period);
  const params = new URLSearchParams({
    function: func, symbol: avSym, apikey: AV_KEY,
    outputsize: compact === false ? 'full' : 'compact',
  });
  if (interval) params.set('interval', interval);

  const r = await fetch(`${AV_BASE}?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`AV HTTP ${r.status}`);
  const data = await r.json();
  if (data.Note || data.Information) throw new Error('Alpha Vantage rate limit');

  // Vind de time series key
  const key = Object.keys(data).find(k => k.includes('Time Series'));
  if (!key) throw new Error(`Geen AV time series data voor ${avSym}`);

  const series = data[key];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (PERIOD_DAYS[period] || 365));

  const candles = Object.entries(series)
    .filter(([date]) => new Date(date) >= cutoff)
    .sort(([a], [b]) => new Date(a) - new Date(b))
    .map(([date, v]) => ({
      t: new Date(date).getTime(),
      o: parseFloat(v['1. open']),
      h: parseFloat(v['2. high']),
      l: parseFloat(v['3. low']),
      c: parseFloat(v['4. close']),
      v: parseInt(v['5. volume'] || '0'),
    }))
    .filter(c => !isNaN(c.c) && c.c > 0);

  return candles;
}

async function fetchTDHistory(sym, period) {
  if (!TD_KEY) throw new Error('Geen Twelve Data key');
  const MAP = {
    '15M':{interval:'15min',outputsize:96},
    '1U': {interval:'1h',   outputsize:120},
    '1M': {interval:'1day', outputsize:30},
    '3M': {interval:'1day', outputsize:90},
    '6M': {interval:'1day', outputsize:180},
    '1J': {interval:'1day', outputsize:365},
    '2J': {interval:'1week',outputsize:104},
    '5J': {interval:'1week',outputsize:260},
    'MAX':{interval:'1month',outputsize:120},
  };
  const { interval, outputsize } = MAP[period] || MAP['1J'];
  const r = await fetch(
    `${TD_BASE}/time_series?symbol=${sym}&interval=${interval}&outputsize=${outputsize}&order=ASC&apikey=${TD_KEY}`,
    { signal: AbortSignal.timeout(15000) }
  );
  if (!r.ok) throw new Error(`Twelve Data HTTP ${r.status}`);
  const d = await r.json();
  if (d.status === 'error') throw new Error(d.message);
  return (d.values || []).map(v => ({
    t: new Date(v.datetime + 'Z').getTime(),
    o: parseFloat(v.open), h: parseFloat(v.high),
    l: parseFloat(v.low),  c: parseFloat(v.close),
    v: parseInt(v.volume || '0'),
  })).filter(c => !isNaN(c.c) && c.c > 0);
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  }

  const rawSym = event.queryStringParameters?.symbol || '';
  const period = event.queryStringParameters?.period || '1J';
  if (!rawSym) return { statusCode: 400, body: JSON.stringify({ error: 'Geen symbool' }) };

  const avSym = AV_SYM[rawSym];
  const tdSym = TD_US[rawSym];

  try {
    let candles;
    let currency = 'EUR';

    if (avSym) {
      candles  = await fetchAVHistory(avSym, period);
      currency = avSym.includes('.BRU') || avSym.includes('.DEX') || avSym.includes('.AMS') ? 'EUR' : 'USD';
      console.log(`✓ AV history ${rawSym}: ${candles.length} candles`);
    } else if (tdSym) {
      candles  = await fetchTDHistory(tdSym, period);
      currency = 'USD';
      console.log(`✓ TD history ${rawSym}: ${candles.length} candles`);
    } else {
      // Probeer Alpha Vantage met het ruwe symbool
      candles  = await fetchAVHistory(rawSym, period);
      currency = rawSym.endsWith('.BR') || rawSym.endsWith('.DE') ? 'EUR' : 'USD';
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      },
      body: JSON.stringify({ symbol: rawSym, currency, candles }),
    };
  } catch(e) {
    console.error(`History error ${rawSym}: ${e.message}`);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: e.message }),
    };
  }
}
