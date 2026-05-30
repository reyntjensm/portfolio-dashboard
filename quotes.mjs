// netlify/functions/history.mjs
// Historische koersen:
// - US (AAPL, GOOGL): Twelve Data (gratis tier werkt voor US)
// - EU (ACKB, SOF, IFX): Stooq.com historische CSV (gratis, geen key)

const TD_KEY  = process.env.TWELVE_DATA_KEY || '';
const TD_BASE = 'https://api.twelvedata.com';

// Stooq symbolen voor Europese aandelen
const STOOQ_SYM = {
  'ACKB':    'aka.br',
  'SOF':     'sof.br',
  'IFX':     'ifx.de',
  'AKA.BR':  'aka.br',
  'SOF.BR':  'sof.br',
  'IFX.DE':  'ifx.de',
  'ASML.AS': 'asml.nl',
  'KBC.BR':  'kbc.br',
  'UCB.BR':  'ucb.br',
  'BAS.DE':  'bas.de',
  'SAP.DE':  'sap.de',
};

// Twelve Data config voor US stocks
const TD_US = {
  'AAPL':  'AAPL',
  'GOOGL': 'GOOGL',
  'NVDA':  'NVDA',
  'MSFT':  'MSFT',
  'AMZN':  'AMZN',
};

// Dashboard period → params
const PERIOD_MAP = {
  '15M': { interval:'15min', outputsize: 96,  stooqInterval:'5' },
  '1U':  { interval:'1h',    outputsize: 120, stooqInterval:'60' },
  '1M':  { interval:'1day',  outputsize: 30,  stooqInterval:'d' },
  '3M':  { interval:'1day',  outputsize: 90,  stooqInterval:'d' },
  '6M':  { interval:'1day',  outputsize: 180, stooqInterval:'d' },
  '1J':  { interval:'1day',  outputsize: 365, stooqInterval:'d' },
  '2J':  { interval:'1week', outputsize: 104, stooqInterval:'w' },
  '5J':  { interval:'1week', outputsize: 260, stooqInterval:'m' },
  'MAX': { interval:'1month',outputsize: 120, stooqInterval:'m' },
};

// Haal historische data op van Stooq (CSV)
async function fetchStooqHistory(stooqSym, period) {
  const cfg = PERIOD_MAP[period] || PERIOD_MAP['1J'];
  const interval = cfg.stooqInterval;

  // Stooq historische CSV: d=daily, w=weekly, m=monthly, 5=5min, 60=1hour
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=${interval}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Stooq history HTTP ${r.status}`);
  const text = await r.text();

  // CSV: Date,Open,High,Low,Close,Volume
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('Stooq: geen historische data');

  const candles = [];
  // Sla header over, verwerk data (Stooq geeft oudste eerst)
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 5) continue;
    const dateStr = parts[0].trim(); // YYYY-MM-DD
    const o = parseFloat(parts[1]);
    const h = parseFloat(parts[2]);
    const l = parseFloat(parts[3]);
    const c = parseFloat(parts[4]);
    const v = parseInt(parts[5] || '0');
    if (!c || isNaN(c)) continue;

    // Converteer datum naar timestamp
    const t = new Date(dateStr + 'T12:00:00Z').getTime();
    if (isNaN(t)) continue;

    candles.push({ t, o, h, l, c, v });
  }

  if (!candles.length) throw new Error('Stooq: geen geldige candles');

  // Beperk aantal candles op basis van periode
  const maxCandles = cfg.outputsize * 2; // ruime marge
  const trimmed = candles.slice(-maxCandles);

  return trimmed;
}

// Haal historische data op van Twelve Data (US stocks)
async function fetchTwelveDataHistory(sym, period) {
  if (!TD_KEY) throw new Error('Geen Twelve Data key');
  const cfg = PERIOD_MAP[period] || PERIOD_MAP['1J'];
  const url = `${TD_BASE}/time_series?symbol=${sym}&interval=${cfg.interval}&outputsize=${cfg.outputsize}&order=ASC&apikey=${TD_KEY}`;

  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Twelve Data HTTP ${r.status}`);
  const data = await r.json();
  if (data.status === 'error') throw new Error(data.message || 'Twelve Data fout');

  const values = data.values || [];
  if (!values.length) throw new Error('Geen data van Twelve Data');

  return values.map(v => ({
    t: new Date(v.datetime + 'Z').getTime(),
    o: parseFloat(v.open),
    h: parseFloat(v.high),
    l: parseFloat(v.low),
    c: parseFloat(v.close),
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

  const stooqSym = STOOQ_SYM[rawSym];
  const tdSym    = TD_US[rawSym];
  const isEU     = !!stooqSym;
  const isUS     = !!tdSym;

  try {
    let candles;
    let currency = 'EUR';
    let source   = '';

    if (isEU) {
      // Europees aandeel → Stooq historische data
      candles  = await fetchStooqHistory(stooqSym, period);
      currency = 'EUR';
      source   = 'Stooq';
      console.log(`✓ Stooq history ${rawSym}: ${candles.length} candles`);

    } else if (isUS) {
      // US aandeel → Twelve Data
      candles  = await fetchTwelveDataHistory(tdSym, period);
      currency = 'USD';
      source   = 'Twelve Data';
      console.log(`✓ Twelve Data history ${rawSym}: ${candles.length} candles`);

    } else {
      // Onbekend symbool → probeer Stooq met directe naam
      // Auto-detectie: eindigt op .br/.de/.as → Stooq
      let autoSym = rawSym.toLowerCase();
      if (autoSym.endsWith('.br')) autoSym = autoSym.replace('.br', '.br');
      else if (autoSym.endsWith('.de')) autoSym = autoSym;
      else if (autoSym.endsWith('.as')) autoSym = autoSym.replace('.as', '.nl');
      candles  = await fetchStooqHistory(autoSym, period);
      currency = 'EUR';
      source   = 'Stooq (auto)';
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': `public, max-age=${period === '15M' || period === '1U' ? 60 : 300}`,
      },
      body: JSON.stringify({ symbol: rawSym, currency, source, candles }),
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
