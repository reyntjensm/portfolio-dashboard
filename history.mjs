// netlify/functions/analysts.mjs
// Analisten data via:
// - Finnhub: upgrades/downgrades (real-time, gratis)
// - Alpha Vantage: company overview met analyst target price
// - Finnhub: recommendation trends

const AV_KEY = process.env.ALPHA_VANTAGE_KEY || 'YV7LYG7RHI1SPAS6';
const FH_KEY = 'd81im41r01qrojfbo940d81im41r01qrojfbo94g';

// Symbool mappings
const AV_SYM = {
  'AAPL':'AAPL', 'GOOGL':'GOOGL',
  'ACKB':'AKA.BRU', 'SOF':'SOF.BRU', 'IFX':'IFX.DEX',
};
const FH_SYM = {
  'AAPL':'AAPL', 'GOOGL':'GOOGL',
  'ACKB':'AKA', 'SOF':'SOF', 'IFX':'IFX',
};

async function fetchAVOverview(sym) {
  const avSym = AV_SYM[sym] || sym;
  const url   = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(avSym)}&apikey=${AV_KEY}`;
  const r     = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`AV Overview HTTP ${r.status}`);
  const d = await r.json();
  if (!d.Symbol || d.Note || d.Information) return null;
  return {
    name:          d.Name,
    exchange:      d.Exchange,
    currency:      d.Currency,
    pe:            d.PERatio        ? +parseFloat(d.PERatio).toFixed(1)    : null,
    forwardPE:     d.ForwardPE      ? +parseFloat(d.ForwardPE).toFixed(1)  : null,
    beta:          d.Beta           ? +parseFloat(d.Beta).toFixed(2)       : null,
    divYield:      d.DividendYield  ? +(parseFloat(d.DividendYield)*100).toFixed(2) : null,
    profitMargin:  d.ProfitMargin   ? +(parseFloat(d.ProfitMargin)*100).toFixed(1)  : null,
    grossMargin:   d.GrossProfitTTM ? null : null,
    roe:           d.ReturnOnEquityTTM ? +(parseFloat(d.ReturnOnEquityTTM)*100).toFixed(1) : null,
    mktCap:        d.MarketCapitalization ? parseInt(d.MarketCapitalization) : null,
    targetPrice:   d.AnalystTargetPrice ? parseFloat(d.AnalystTargetPrice) : null,
    analystRating: d.AnalystRatingStrongBuy || d.AnalystRatingBuy ? {
      strongBuy:  parseInt(d.AnalystRatingStrongBuy  || '0'),
      buy:        parseInt(d.AnalystRatingBuy         || '0'),
      hold:       parseInt(d.AnalystRatingHold        || '0'),
      sell:       parseInt(d.AnalystRatingSell        || '0'),
      strongSell: parseInt(d.AnalystRatingStrongSell  || '0'),
    } : null,
    week52High: d['52WeekHigh'] ? parseFloat(d['52WeekHigh']) : null,
    week52Low:  d['52WeekLow']  ? parseFloat(d['52WeekLow'])  : null,
  };
}

async function fetchFHUpgrades(sym) {
  const fhSym = FH_SYM[sym] || sym.split('.')[0];
  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/stock/upgrade-downgrade?symbol=${fhSym}&token=${FH_KEY}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return [];
    const data = await r.json();
    return (Array.isArray(data) ? data : [])
      .sort((a,b) => new Date(b.gradeDate) - new Date(a.gradeDate))
      .slice(0, 10)
      .map(u => ({
        gradeDate:  u.gradeDate,
        firm:       u.company,
        action:     u.action,
        fromGrade:  u.fromGrade,
        toGrade:    u.toGrade,
        actionNl:   u.action === 'upgrade'    ? '↑ Upgrade'
                  : u.action === 'downgrade'  ? '↓ Downgrade'
                  : u.action === 'initiated'  ? '★ Initiatie'
                  : u.action === 'reiterated' ? '→ Herhaald'
                  : '→ Bevestigd',
        sentiment:  u.action === 'upgrade' || u.action === 'initiated' ? 'positive'
                  : u.action === 'downgrade' ? 'negative' : 'neutral',
      }));
  } catch(e) { return []; }
}

async function fetchFHRecommendations(sym) {
  const fhSym = FH_SYM[sym] || sym.split('.')[0];
  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/stock/recommendation?symbol=${fhSym}&token=${FH_KEY}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data.slice(0, 4) : [];
  } catch(e) { return []; }
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  }

  const sym = event.queryStringParameters?.symbol || '';
  if (!sym) return { statusCode: 400, body: JSON.stringify({ error: 'Geen symbool' }) };

  // Parallel ophalen
  const [overview, upgrades, recommendations] = await Promise.all([
    fetchAVOverview(sym).catch(e => { console.warn('AV Overview:', e.message); return null; }),
    fetchFHUpgrades(sym),
    fetchFHRecommendations(sym),
  ]);

  // Bouw analisten samenvatting
  let analystSummary = null;
  if (overview?.analystRating) {
    const r = overview.analystRating;
    const total = r.strongBuy + r.buy + r.hold + r.sell + r.strongSell;
    const buy   = r.strongBuy + r.buy;
    const sell  = r.sell + r.strongSell;
    analystSummary = {
      buy, hold: r.hold, sell, total,
      strongBuy: r.strongBuy, strongSell: r.strongSell,
      consensus: buy/total > 0.6  ? 'Sterk Kopen'
               : buy/total > 0.4  ? 'Kopen'
               : sell/total > 0.4 ? 'Verkopen'
               :                    'Houden',
      avgTarget:  overview.targetPrice ? Math.round(overview.targetPrice) : null,
      highTarget: null, lowTarget: null,
    };
  } else if (recommendations.length) {
    const r0 = recommendations[0];
    const buy  = (r0.strongBuy||0) + (r0.buy||0);
    const hold =  r0.hold||0;
    const sell = (r0.strongSell||0) + (r0.sell||0);
    const total = buy + hold + sell || 1;
    analystSummary = {
      buy, hold, sell, total,
      strongBuy: r0.strongBuy||0, strongSell: r0.strongSell||0,
      consensus: buy/total > 0.6  ? 'Sterk Kopen'
               : buy/total > 0.4  ? 'Kopen'
               : sell/total > 0.4 ? 'Verkopen'
               :                    'Houden',
      avgTarget: null, highTarget: null, lowTarget: null,
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600', // 1 uur
    },
    body: JSON.stringify({
      symbol: sym,
      overview,
      upgrades,
      recommendations,
      analystSummary,
    }),
  };
}
