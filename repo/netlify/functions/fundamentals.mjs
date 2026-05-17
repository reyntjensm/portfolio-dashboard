// netlify/functions/fundamentals.mjs
// Haalt fundamentele data op via SEC EDGAR (gratis, geen key) + Yahoo Finance
// SEC EDGAR werkt enkel voor US-genoteerde bedrijven met een CIK

const TICKER_TO_CIK = {
  'AAPL':  '0000320193',
  'GOOGL': '0001652044',
  'MSFT':  '0000789019',
  'NVDA':  '0001045810',
  'AMZN':  '0001018724',
  'META':  '0001326801',
};

async function fetchSECFacts(cik) {
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'PortfolioDashboard contact@portfolio.app',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`SEC EDGAR ${res.status}`);
  return res.json();
}

function extractFact(facts, concept, unit='USD') {
  const data = facts?.facts?.['us-gaap']?.[concept]?.units?.[unit];
  if (!data || !Array.isArray(data)) return null;
  // Pak meest recente jaarlijkse waarde (form 10-K)
  const annual = data.filter(d => d.form === '10-K' || d.form === '20-F').sort((a,b) => b.end.localeCompare(a.end));
  const quarterly = data.filter(d => d.form === '10-Q').sort((a,b) => b.end.localeCompare(a.end));
  return { annual: annual[0]?.val, quarterly: quarterly[0]?.val, recent: (annual[0] || quarterly[0])?.val };
}

async function fetchYahooFundamentals(sym) {
  try {
    // Cookie voor Yahoo
    let cookie = '';
    try {
      const cr = await fetch('https://finance.yahoo.com/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
      });
      const sc = cr.headers.get('set-cookie') || '';
      const m = sc.match(/A1=([^;]+)/);
      if (m) cookie = `A1=${m[1]}`;
    } catch(e) {}

    const hdrs = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://finance.yahoo.com/',
    };
    if (cookie) hdrs['Cookie'] = cookie;

    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=incomeStatementHistory,balanceSheetHistory,cashflowStatementHistory,earningsHistory,earningsTrend`;
    const res = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.quoteSummary?.result?.[0] || null;
  } catch(e) {
    return null;
  }
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  }

  const sym = event.queryStringParameters?.symbol || '';
  if (!sym) return { statusCode: 400, body: JSON.stringify({ error: 'Geen symbool' }) };

  const results = { symbol: sym, sec: null, yahoo: null };

  // SEC EDGAR (enkel voor US stocks)
  const cik = TICKER_TO_CIK[sym.toUpperCase()];
  if (cik) {
    try {
      const facts = await fetchSECFacts(cik);
      results.sec = {
        revenue:     extractFact(facts, 'Revenues')?.annual
                  || extractFact(facts, 'RevenueFromContractWithCustomerExcludingAssessedTax')?.annual,
        netIncome:   extractFact(facts, 'NetIncomeLoss')?.annual,
        eps:         extractFact(facts, 'EarningsPerShareBasic', 'USD/shares')?.annual,
        totalAssets: extractFact(facts, 'Assets')?.recent,
        totalDebt:   extractFact(facts, 'LongTermDebt')?.recent,
        cashAndEq:   extractFact(facts, 'CashAndCashEquivalentsAtCarryingValue')?.recent,
        freeCashFlow:extractFact(facts, 'NetCashProvidedByUsedInOperatingActivities')?.annual,
        rndExpense:  extractFact(facts, 'ResearchAndDevelopmentExpense')?.annual,
        sharesOut:   extractFact(facts, 'CommonStockSharesOutstanding', 'shares')?.recent,
        entityName:  facts?.entityName,
      };
    } catch(e) {
      console.warn('SEC EDGAR failed:', e.message);
    }
  }

  // Yahoo Finance fundamentals
  try {
    const yData = await fetchYahooFundamentals(sym);
    if (yData) {
      const et = yData.earningsTrend?.trend || [];
      const eh = yData.earningsHistory?.history || [];
      results.yahoo = {
        // EPS surprises (afgelopen 4 kwartalen)
        epsSurprises: eh.slice(0, 4).map(h => ({
          quarter: h.period,
          actual:  h.epsActual?.raw,
          estimate:h.epsEstimate?.raw,
          surprise:h.surprisePercent?.raw,
          date:    h.quarter?.fmt,
        })),
        // Analisten EPS verwachtingen
        epsForward: et.filter(t => t.period === '+1q' || t.period === '0q').map(t => ({
          period:  t.period,
          low:     t.earningsEstimate?.low?.raw,
          avg:     t.earningsEstimate?.avg?.raw,
          high:    t.earningsEstimate?.high?.raw,
          growth:  t.earningsEstimate?.growth?.raw,
        })),
        // Omzet verwachtingen
        revenueForward: et.filter(t => t.period === '+1q' || t.period === '0q').map(t => ({
          period: t.period,
          low:    t.revenueEstimate?.low?.raw,
          avg:    t.revenueEstimate?.avg?.raw,
          high:   t.revenueEstimate?.high?.raw,
        })),
      };
    }
  } catch(e) {
    console.warn('Yahoo fundamentals failed:', e.message);
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600', // 1 uur cache
    },
    body: JSON.stringify(results),
  };
}
