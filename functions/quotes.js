// functions/quotes.js — Cloudflare Pages Function
// Koersen: Finnhub (US) + Alpha Vantage (EU)

const AV_KEY = 'YV7LYG7RHI1SPAS6';
const FH_KEY = 'd81im41r01qrojfbo940d81im41r01qrojfbo94g';

const SYMBOLS = {
  AAPL:    { type:'us',  av:'AAPL',    fh:'AAPL'  },
  GOOGL:   { type:'us',  av:'GOOGL',   fh:'GOOGL' },
  ACKB:    { type:'eu',  av:'AKA.BRU', fh:null    },
  SOF:     { type:'eu',  av:'SOF.BRU', fh:null    },
  IFX:     { type:'eu',  av:'IFX.DEX', fh:null    },
  'AKA.BR':{ type:'eu',  av:'AKA.BRU', fh:null    },
  'SOF.BR':{ type:'eu',  av:'SOF.BRU', fh:null    },
  'IFX.DE':{ type:'eu',  av:'IFX.DEX', fh:null    },
  'KBC.BR':{ type:'eu',  av:'KBC.BRU', fh:null    },
  'UCB.BR':{ type:'eu',  av:'UCB.BRU', fh:null    },
  'ASML.AS':{ type:'eu', av:'ASML.AMS',fh:'ASML'  },
  NVDA:    { type:'us',  av:'NVDA',    fh:'NVDA'  },
  MSFT:    { type:'us',  av:'MSFT',    fh:'MSFT'  },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

function getConfig(sym) {
  if (SYMBOLS[sym]) return SYMBOLS[sym];
  if (sym.endsWith('.BR')) return { type:'eu', av:sym.replace('.BR','.BRU'), fh:null };
  if (sym.endsWith('.DE')) return { type:'eu', av:sym.replace('.DE','.DEX'), fh:null };
  if (sym.endsWith('.AS')) return { type:'eu', av:sym.replace('.AS','.AMS'), fh:null };
  return { type:'us', av:sym, fh:sym };
}

async function fetchFinnhub(sym) {
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FH_KEY}`);
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  const q = await r.json();
  if (!q.c || q.c === 0) throw new Error('Geen Finnhub data');
  return {
    price:q.c, chgAbs:+(q.d||0).toFixed(4), chgPct:+(q.dp||0).toFixed(4),
    prevClose:q.pc||q.c, dayHigh:q.h||null, dayLow:q.l||null,
    wkHigh:null, wkLow:null, currency:'USD', name:sym, exchange:'NASDAQ',
    mktCap:null, pe:null, targetLow:null, targetMean:null, targetHigh:null,
    numAnalysts:null, recKey:null, strongBuy:0, buy:0, hold:0, sell:0, strongSell:0,
  };
}

async function fetchAV(avSym) {
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(avSym)}&apikey=${AV_KEY}`;
  const r   = await fetch(url);
  if (!r.ok) throw new Error(`AV ${r.status}`);
  const data = await r.json();
  if (data.Note || data.Information) throw new Error('AV rate limit');
  const q = data['Global Quote'];
  if (!q || !q['05. price']) throw new Error(`Geen AV data voor ${avSym}`);
  const price  = parseFloat(q['05. price']);
  const prev   = parseFloat(q['08. previous close'] || q['05. price']);
  const chgAbs = parseFloat(q['09. change'] || '0');
  const chgPct = parseFloat((q['10. change percent']||'0%').replace('%',''));
  const isEU   = avSym.includes('.BRU') || avSym.includes('.DEX') || avSym.includes('.AMS');
  return {
    price, chgAbs:+chgAbs.toFixed(4), chgPct:+chgPct.toFixed(4),
    prevClose:prev, dayHigh:parseFloat(q['03. high'])||null, dayLow:parseFloat(q['04. low'])||null,
    wkHigh:null, wkLow:null, currency:isEU?'EUR':'USD',
    name:avSym, exchange:avSym.split('.').pop()||'',
    mktCap:null, pe:null, targetLow:null, targetMean:null, targetHigh:null,
    numAnalysts:null, recKey:null, strongBuy:0, buy:0, hold:0, sell:0, strongSell:0,
  };
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') {
    return new Response('', { headers: CORS });
  }

  const url     = new URL(request.url);
  const symbols = (url.searchParams.get('symbols') || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (!symbols.length) {
    return new Response(JSON.stringify({error:'Geen symbolen'}), { status:400, headers:CORS });
  }

  const results = {};
  for (const sym of symbols) {
    const cfg = getConfig(sym);
    try {
      if (cfg.type === 'us' && cfg.fh) {
        try {
          results[sym] = await fetchFinnhub(cfg.fh);
        } catch(e1) {
          results[sym] = await fetchAV(cfg.av);
        }
      } else {
        results[sym] = await fetchAV(cfg.av);
      }
    } catch(e) {
      results[sym] = { error: e.message };
    }
    await new Promise(r => setTimeout(r, 300));
  }

  return new Response(JSON.stringify(results), {
    headers: { ...CORS, 'Cache-Control': 'public, max-age=300' }
  });
}
