// netlify/functions/quotes.mjs
// Stabiele koersen via:
// - AAPL/GOOGL: Finnhub (real-time, gratis)
// - ACKB/SOF/IFX: Stooq.com (gratis, geen key, ~15min vertraging)
// - Fallback: Twelve Data EOD

const FH_KEY  = 'd81im41r01qrojfbo940d81im41r01qrojfbo94g';
const TD_KEY  = process.env.TWELVE_DATA_KEY || '';
const TD_BASE = 'https://api.twelvedata.com';

// Stooq symbolen voor Europese aandelen
// Stooq gebruikt .br voor Brussel, .de voor XETRA
const STOOQ_SYM = {
  'ACKB':    'aka.br',
  'SOF':     'sof.br',
  'IFX':     'ifx.de',
  'AKA.BR':  'aka.br',
  'SOF.BR':  'sof.br',
  'IFX.DE':  'ifx.de',
  'KBC.BR':  'kbc.br',
  'UCB.BR':  'ucb.br',
  'ASML.AS': 'asml.nl',
  'BAS.DE':  'bas.de',
  'SAP.DE':  'sap.de',
};

// Twelve Data exchange config voor fallback
const TD_CONFIG = {
  'ACKB':    { sym: 'AKA',  exchange: 'Euronext' },
  'SOF':     { sym: 'SOF',  exchange: 'Euronext' },
  'IFX':     { sym: 'IFX',  exchange: 'XETR'    },
  'AKA.BR':  { sym: 'AKA',  exchange: 'Euronext' },
  'SOF.BR':  { sym: 'SOF',  exchange: 'Euronext' },
  'IFX.DE':  { sym: 'IFX',  exchange: 'XETR'    },
  'ASML.AS': { sym: 'ASML', exchange: 'Euronext' },
  'KBC.BR':  { sym: 'KBC',  exchange: 'Euronext' },
};

// ── Finnhub — US real-time ─────────────────────────────────────────────────────
async function fetchFinnhub(sym) {
  const r = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FH_KEY}`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  const q = await r.json();
  if (!q.c || q.c === 0) throw new Error('Geen Finnhub data');
  return {
    price: q.c, currency: 'USD',
    chgAbs: +(q.d||0).toFixed(4), chgPct: +(q.dp||0).toFixed(4),
    prevClose: q.pc||q.c, dayHigh: q.h||null, dayLow: q.l||null,
    wkHigh: null, wkLow: null, name: sym, exchange: 'NASDAQ',
    source: 'Finnhub real-time',
  };
}

// ── Stooq — Europese aandelen, CSV endpoint, gratis, ~15min ──────────────────
async function fetchStooq(stooqSym, currency='EUR') {
  // Stooq biedt een CSV endpoint dat koersen teruggeeft
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&h&e=csv`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Stooq HTTP ${r.status}`);
  const text = await r.text();

  // CSV formaat: Symbol,Date,Time,Open,High,Low,Close,Volume
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('Stooq: geen data');
  const vals = lines[1].split(',');
  if (vals.length < 7) throw new Error('Stooq: onvolledig antwoord');

  const price  = parseFloat(vals[6]); // Close
  const open   = parseFloat(vals[3]);
  const high   = parseFloat(vals[4]);
  const low    = parseFloat(vals[5]);
  const vol    = parseInt(vals[7]||'0');

  if (!price || isNaN(price)) throw new Error('Stooq: ongeldige koers');

  // Dagwijziging tov open (Stooq geeft geen prev close)
  const chgAbs = price - open;
  const chgPct = open ? chgAbs / open * 100 : 0;

  return {
    price, currency,
    chgAbs: +chgAbs.toFixed(4), chgPct: +chgPct.toFixed(4),
    prevClose: open, dayHigh: high||null, dayLow: low||null,
    wkHigh: null, wkLow: null,
    name: stooqSym.toUpperCase(), exchange: '',
    source: 'Stooq (~15min vertraging)',
  };
}

// ── Twelve Data — EOD fallback ─────────────────────────────────────────────────
async function fetchTwelveData(sym, exchange, currency='EUR') {
  if (!TD_KEY) throw new Error('Geen Twelve Data key');
  const params = new URLSearchParams({
    symbol: sym, interval: '1day', outputsize: '2',
    order: 'DESC', apikey: TD_KEY,
  });
  if (exchange) params.set('exchange', exchange);
  const r = await fetch(`${TD_BASE}/time_series?${params}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Twelve Data ${r.status}`);
  const d = await r.json();
  if (d.status === 'error') throw new Error(d.message);
  const vals = d.values || [];
  if (!vals.length) throw new Error('Geen Twelve Data data');

  const price  = parseFloat(vals[0].close);
  const prev   = vals.length > 1 ? parseFloat(vals[1].close) : price;
  const chgAbs = price - prev;
  const chgPct = prev ? chgAbs / prev * 100 : 0;

  return {
    price, currency: d.meta?.currency || currency,
    chgAbs: +chgAbs.toFixed(4), chgPct: +chgPct.toFixed(4),
    prevClose: prev, dayHigh: parseFloat(vals[0].high)||null,
    dayLow: parseFloat(vals[0].low)||null, wkHigh: null, wkLow: null,
    name: d.meta?.symbol || sym, exchange: d.meta?.exchange || '',
    source: 'Twelve Data EOD',
  };
}

// ── Finale resultaatverwerking ─────────────────────────────────────────────────
function finalize(raw) {
  return {
    ...raw,
    mktCap: null, pe: null,
    targetLow: null, targetMean: null, targetHigh: null,
    numAnalysts: null, recKey: null,
    strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  }

  const symbols = (event.queryStringParameters?.symbols || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Geen symbolen' }) };
  }

  const results = {};

  await Promise.allSettled(symbols.map(async sym => {
    try {
      const stooqSym = STOOQ_SYM[sym];
      const tdCfg    = TD_CONFIG[sym];
      const isEU     = !!(stooqSym || tdCfg);

      if (!isEU) {
        // US stock — Finnhub primair, Twelve Data fallback
        try {
          results[sym] = finalize(await fetchFinnhub(sym));
          console.log(`✓ Finnhub ${sym}: $${results[sym].price}`);
        } catch(e1) {
          console.warn(`Finnhub ${sym} mislukt: ${e1.message}`);
          results[sym] = finalize(await fetchTwelveData(sym, null, 'USD'));
          console.log(`✓ TwelveData ${sym}: $${results[sym].price}`);
        }
      } else {
        // Europees aandeel — Stooq primair, Twelve Data EOD fallback
        try {
          if (!stooqSym) throw new Error('Geen Stooq symbool');
          results[sym] = finalize(await fetchStooq(stooqSym, 'EUR'));
          console.log(`✓ Stooq ${sym}: €${results[sym].price}`);
        } catch(e1) {
          console.warn(`Stooq ${sym} mislukt: ${e1.message}`);
          if (!tdCfg) throw new Error(`Geen fallback configuratie voor ${sym}`);
          results[sym] = finalize(await fetchTwelveData(tdCfg.sym, tdCfg.exchange, 'EUR'));
          console.log(`✓ TwelveData EOD ${sym}: €${results[sym].price}`);
        }
      }
    } catch(e) {
      results[sym] = { error: e.message };
      console.error(`✗ ${sym}: ${e.message}`);
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
