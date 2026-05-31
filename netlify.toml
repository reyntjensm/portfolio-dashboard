// netlify/functions/quotes.mjs
// Alpha Vantage (officieel gelicenseerd, gratis tier: 25 calls/dag)
// + Finnhub voor US stocks (real-time, gratis)
// Alpha Vantage key: stel in als ALPHA_VANTAGE_KEY environment variable in Netlify

const AV_KEY  = process.env.ALPHA_VANTAGE_KEY || 'YV7LYG7RHI1SPAS6';
const FH_KEY  = 'd81im41r01qrojfbo940d81im41r01qrojfbo94g';
const AV_BASE = 'https://www.alphavantage.co/query';

// Alpha Vantage symboolformaat
const AV_SYM = {
  'AAPL':  'AAPL',
  'GOOGL': 'GOOGL',
  'ACKB':  'AKA.BRU',   // Euronext Brussels
  'SOF':   'SOF.BRU',   // Euronext Brussels
  'IFX':   'IFX.DEX',   // XETRA
  // Watchlist aliassen
  'AKA.BR':  'AKA.BRU',
  'SOF.BR':  'SOF.BRU',
  'IFX.DE':  'IFX.DEX',
  'KBC.BR':  'KBC.BRU',
  'UCB.BR':  'UCB.BRU',
  'ASML.AS': 'ASML.AMS',
};

function resolveAV(sym) {
  if (AV_SYM[sym]) return AV_SYM[sym];
  // Auto-detectie
  if (sym.endsWith('.BR')) return sym.replace('.BR', '.BRU');
  if (sym.endsWith('.DE')) return sym.replace('.DE', '.DEX');
  if (sym.endsWith('.AS')) return sym.replace('.AS', '.AMS');
  if (sym.endsWith('.PA')) return sym.replace('.PA', '.PAR');
  return sym;
}

async function fetchAV(avSym) {
  // AV_KEY ingebakken als fallback
  const url = `${AV_BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(avSym)}&apikey=${AV_KEY}`;
  const r   = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Alpha Vantage HTTP ${r.status}`);
  const data = await r.json();

  // Check voor rate limit
  if (data.Note || data.Information) {
    throw new Error('Alpha Vantage rate limit bereikt (25 calls/dag op gratis tier)');
  }

  const q = data['Global Quote'];
  if (!q || !q['05. price']) throw new Error(`Geen Alpha Vantage data voor ${avSym}`);

  const price    = parseFloat(q['05. price']);
  const prev     = parseFloat(q['08. previous close']);
  const chgAbs   = parseFloat(q['09. change']);
  const chgPct   = parseFloat(q['10. change percent'].replace('%', ''));
  const dayHigh  = parseFloat(q['03. high']);
  const dayLow   = parseFloat(q['04. low']);
  const volume   = parseInt(q['06. volume']);

  const isEU = avSym.includes('.BRU') || avSym.includes('.DEX') || avSym.includes('.AMS');

  return {
    price, currency: isEU ? 'EUR' : 'USD',
    chgAbs: +chgAbs.toFixed(4),
    chgPct: +chgPct.toFixed(4),
    prevClose: prev,
    dayHigh: dayHigh || null,
    dayLow:  dayLow  || null,
    wkHigh: null, wkLow: null,
    name:     avSym,
    exchange: isEU ? avSym.split('.').pop() : 'NASDAQ',
    mktCap: null, pe: null,
    targetLow: null, targetMean: null, targetHigh: null,
    numAnalysts: null, recKey: null,
    strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0,
  };
}

async function fetchFinnhub(sym) {
  const r = await fetch(
    `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FH_KEY}`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) throw new Error(`Finnhub HTTP ${r.status}`);
  const q = await r.json();
  if (!q.c || q.c === 0) throw new Error('Geen Finnhub data');
  return {
    price: q.c, currency: 'USD',
    chgAbs: +(q.d||0).toFixed(4),
    chgPct: +(q.dp||0).toFixed(4),
    prevClose: q.pc || q.c,
    dayHigh: q.h || null, dayLow: q.l || null,
    wkHigh: null, wkLow: null,
    name: sym, exchange: 'NASDAQ',
    mktCap: null, pe: null,
    targetLow: null, targetMean: null, targetHigh: null,
    numAnalysts: null, recKey: null,
    strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0,
  };
}

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

  // Verwerk sequentieel om rate limit te respecteren (5 calls/min)
  for (const orig of symbols) {
    const avSym = resolveAV(orig);
    const isEU  = avSym.includes('.BRU') || avSym.includes('.DEX') || avSym.includes('.AMS');

    try {
      if (!isEU) {
        // US stocks: Finnhub primair (real-time), Alpha Vantage als fallback
        try {
          results[orig] = await fetchFinnhub(orig);
          console.log(`✓ Finnhub ${orig}: $${results[orig].price}`);
        } catch(e1) {
          console.warn(`Finnhub mislukt voor ${orig}: ${e1.message}`);
          results[orig] = await fetchAV(avSym);
          console.log(`✓ AV ${orig}: $${results[orig].price}`);
        }
      } else {
        // Europese stocks: Alpha Vantage (officieel gelicenseerd voor EU)
        results[orig] = await fetchAV(avSym);
        console.log(`✓ AV ${orig}: €${results[orig].price}`);
      }
    } catch(e) {
      results[orig] = { error: e.message };
      console.error(`✗ ${orig} (${avSym}): ${e.message}`);
    }

    // Kleine pauze tussen calls om rate limit te vermijden
    if (symbols.indexOf(orig) < symbols.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify(results),
  };
}
