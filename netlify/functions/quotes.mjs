// netlify/functions/quotes.mjs
// Twelve Data API — quotes voor portfolio EN watchlist tickers
// Ondersteunt US + Europese aandelen (Euronext, XETRA, AMS, ...)

const TD_KEY  = process.env.TWELVE_DATA_KEY || 'JOUW_TWELVE_DATA_KEY';
const TD_BASE = 'https://api.twelvedata.com';

// Portfolio tickers → Twelve Data symbool
const TD_SYMBOL = {
  'AAPL':  'AAPL',
  'GOOGL': 'GOOGL',
  'ACKB':  'AKA:BRU',
  'SOF':   'SOF:BRU',
  'IFX':   'IFX:XETR',
  // Yahoo Finance stijl (voor watchlist)
  'AKA.BR':  'AKA:BRU',
  'SOF.BR':  'SOF:BRU',
  'IFX.DE':  'IFX:XETR',
  'ASML.AS': 'ASML:AMS',
  'KBC.BR':  'KBC:BRU',
  'AB.BR':   'ABI:BRU',
  'SOLB.BR': 'SOLB:BRU',
};

function resolveSymbol(sym) {
  if (TD_SYMBOL[sym]) return TD_SYMBOL[sym];
  // Auto-convert Yahoo Finance stijl naar Twelve Data
  if (sym.includes('.BR')) return sym.replace('.BR', ':BRU');
  if (sym.includes('.DE')) return sym.replace('.DE', ':XETR');
  if (sym.includes('.AS')) return sym.replace('.AS', ':AMS');
  if (sym.includes('.PA')) return sym.replace('.PA', ':PAR');
  if (sym.includes('.HE')) return sym.replace('.HE', ':HEL');
  // US ticker — geen aanpassing
  return sym;
}

function processQuote(origSym, tdSym, q) {
  if (!q || q.status === 'error' || !q.close) {
    throw new Error(q?.message || `Geen data voor ${tdSym}`);
  }

  const price  = parseFloat(q.close);
  const prev   = parseFloat(q.previous_close || q.close);
  const chgAbs = price - prev;
  const chgPct = prev ? (chgAbs / prev * 100) : 0;
  const cur    = q.currency || (tdSym.includes(':BRU') || tdSym.includes(':XETR') || tdSym.includes(':AMS') ? 'EUR' : 'USD');

  return {
    price,
    chgAbs:  +chgAbs.toFixed(4),
    chgPct:  +chgPct.toFixed(4),
    prevClose: prev,
    dayHigh:   parseFloat(q.high)  || null,
    dayLow:    parseFloat(q.low)   || null,
    wkHigh:    parseFloat(q.fifty_two_week?.high  || q.high) || null,
    wkLow:     parseFloat(q.fifty_two_week?.low   || q.low)  || null,
    currency:  cur,
    name:      q.name     || origSym,
    exchange:  q.exchange || '—',
    mktCap:    q.market_cap ? parseFloat(q.market_cap) : null,
    pe:        q.pe         ? +parseFloat(q.pe).toFixed(1) : null,
    // Analyst data niet beschikbaar in gratis tier — behoud uit STOCKS
    targetLow: null, targetMean: null, targetHigh: null,
    numAnalysts: null, recKey: null,
    strongBuy:0, buy:0, hold:0, sell:0, strongSell:0,
  };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode:200, headers:{'Access-Control-Allow-Origin':'*'}, body:'' };
  }

  const rawSymbols = (event.queryStringParameters?.symbols || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (!rawSymbols.length) {
    return { statusCode:400, body: JSON.stringify({error:'Geen symbolen'}) };
  }

  // Converteer naar Twelve Data symbolen
  const tdSymbols = rawSymbols.map(resolveSymbol);
  const results   = {};

  // Probeer eerst batch (efficiënter)
  try {
    const symStr = tdSymbols.join(',');
    const url    = `${TD_BASE}/quote?symbol=${encodeURIComponent(symStr)}&apikey=${TD_KEY}`;
    console.log(`Quotes batch: ${symStr}`);

    const r    = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const json = await r.json();

    if (r.ok) {
      rawSymbols.forEach((orig, i) => {
        const tdSym = tdSymbols[i];
        // Batch: als 1 symbool → direct object, anders object met tdSym als key
        const q = rawSymbols.length === 1 ? json : (json[tdSym] || json[orig]);
        try {
          results[orig] = processQuote(orig, tdSym, q);
        } catch(e) {
          results[orig] = { error: e.message };
          console.warn(`Quote error ${orig} (${tdSym}):`, e.message);
        }
      });
      // Check of alle resultaten ingevuld zijn
      if (rawSymbols.every(s => results[s])) {
        return respond(results);
      }
    }
  } catch(e) {
    console.warn('Batch quotes failed, trying individual:', e.message);
  }

  // Fallback: individuele calls voor ontbrekende symbolen
  await Promise.allSettled(rawSymbols.map(async orig => {
    if (results[orig] && !results[orig].error) return; // al succesvol
    const tdSym = resolveSymbol(orig);
    try {
      const url = `${TD_BASE}/quote?symbol=${encodeURIComponent(tdSym)}&apikey=${TD_KEY}`;
      const r   = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const q   = await r.json();
      results[orig] = processQuote(orig, tdSym, q);
    } catch(err) {
      results[orig] = { error: err.message };
      console.error(`Individual quote error ${orig}:`, err.message);
    }
  }));

  return respond(results);
}

function respond(results) {
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
