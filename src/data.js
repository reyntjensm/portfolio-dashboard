// ═══════════════════════════════════════════════════════════════════════════════
// src/data.js — Live data via Yahoo Finance + AI nieuws via Anthropic
// Vervangt alle Alpha Vantage en Finnhub calls uit index.html.
// ═══════════════════════════════════════════════════════════════════════════════

const YF_WORKER = 'https://portfolio-dashboard.michiel-0be.workers.dev/yf';

// Yahoo Finance ticker mapping (portfolio ticker → YF ticker)
// Let op: ACKB → ACKB.BR (niet AKA.BR), GOOGL → GOOG
const YF_SYM_MAP = {
  AAPL:  'AAPL',
  GOOGL: 'GOOG',
  ACKB:  'ACKB.BR',
  SOF:   'SOF.BR',
  IFX:   'IFX.DE',
  // Extra Europese tickers: voeg hier toe indien nodig
  // KBC: 'KBC.BR', UCB: 'UCB.BR', ASML: 'ASML.AS', SAP: 'SAP.DE'
};

// Yahoo Finance periodes voor grafieken
const YF_HIST_CFG = {
  '15M': { range: '1d',  interval: '5m'  },
  '1U':  { range: '5d',  interval: '30m' },
  '1M':  { range: '1mo', interval: '1d'  },
  '3M':  { range: '3mo', interval: '1d'  },
  '6M':  { range: '6mo', interval: '1d'  },
  '1J':  { range: '1y',  interval: '1d'  },
  '2J':  { range: '2y',  interval: '1wk' },
  '5J':  { range: '5y',  interval: '1mo' },
  'MAX': { range: 'max', interval: '1mo' },
};

// ─── IN-MEMORY CACHE ──────────────────────────────────────────────────────────
const _dc = {};
function dcGet(k) {
  const e = _dc[k];
  if (!e || Date.now() - e.ts > e.ttl) return null;
  return e.v;
}
function dcSet(k, v, ttl) { _dc[k] = { v, ts: Date.now(), ttl }; }

// ─── HELPER: fetch via Worker ─────────────────────────────────────────────────
// Alle requests gaan via onze eigen Worker — geen externe CORS proxies meer
async function yfFetch(endpoint, extraParams = {}) {
  // Bouw URL manueel zodat 'endpoint' niet dubbel wordt geëncodeerd
  // door URLSearchParams. De slashes in v8/finance/chart/AAPL moeten intact blijven.
  const extra = Object.entries(extraParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${YF_WORKER}?endpoint=${endpoint}${extra ? '&' + extra : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Worker fout ${res.status} voor ${endpoint}`);
  return res.json();
}

// ─── YAHOO FINANCE: REALTIME KOERS ───────────────────────────────────────────
async function yfQuote(yfSym) {
  const key = 'q_' + yfSym;
  const cached = dcGet(key);
  if (cached) return cached;

  const json = await yfFetch(`v8/finance/chart/${yfSym}`, {
    interval: '1d',
    range: '1d'
  });

  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Geen quote data voor ${yfSym}`);

  const m      = result.meta;
  const price  = m.regularMarketPrice    ?? m.previousClose ?? 0;
  const prev   = m.previousClose         ?? m.chartPreviousClose ?? price;
  const chgAbs = +(price - prev).toFixed(4);
  const chgPct = prev ? +(((price - prev) / prev) * 100).toFixed(4) : 0;
  const isEU   = yfSym.includes('.');

  const out = {
    price, chgAbs, chgPct,
    prevClose:   prev,
    dayHigh:     m.regularMarketDayHigh ?? null,
    dayLow:      m.regularMarketDayLow  ?? null,
    wkHigh:      m.fiftyTwoWeekHigh     ?? null,
    wkLow:       m.fiftyTwoWeekLow      ?? null,
    volume:      m.regularMarketVolume  ?? null,
    mktCap:      m.marketCap            ?? null,
    currency:    m.currency             ?? (isEU ? 'EUR' : 'USD'),
    exchange:    m.exchangeName         ?? '',
    name:        m.longName ?? m.shortName ?? yfSym,
    pe: null, targetLow: null, targetMean: null, targetHigh: null,
    numAnalysts: null, recKey: null,
    strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0,
    error: null,
  };

  dcSet(key, out, 5 * 60 * 1000);
  return out;
}

// ─── YAHOO FINANCE: HISTORISCHE GRAFIEKDATA ───────────────────────────────────
async function yfHistory(yfSym, period) {
  const key = 'h_' + yfSym + '_' + period;
  const cached = dcGet(key);
  if (cached) return cached;

  const cfg = YF_HIST_CFG[period] || YF_HIST_CFG['1J'];
  const json = await yfFetch(`v8/finance/chart/${yfSym}`, {
    range: cfg.range,
    interval: cfg.interval
  });

  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Geen historische data voor ${yfSym}`);

  const ts = result.timestamp ?? [];
  const q  = result.indicators?.quote?.[0] ?? {};

  const candles = ts
    .map((t, i) => ({
      t: t * 1000,
      o: q.open?.[i]   ?? null,
      h: q.high?.[i]   ?? null,
      l: q.low?.[i]    ?? null,
      c: q.close?.[i]  ?? null,
      v: q.volume?.[i] ?? 0,
    }))
    .filter(c => c.c !== null && c.c > 0)
    .sort((a, b) => a.t - b.t);

  if (!candles.length) throw new Error(`Geen candles voor ${yfSym} (${period})`);

  const ttl = ['15M', '1U'].includes(period) ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000;
  dcSet(key, candles, ttl);
  return candles;
}

// ─── YAHOO FINANCE: ANALYST CONSENSUS + RATIOS ───────────────────────────────
async function yfAnalyst(yfSym) {
  const key = 'a_' + yfSym;
  const cached = dcGet(key);
  if (cached) return cached;

  const modules = 'recommendationTrend,upgradeDowngradeHistory,financialData,defaultKeyStatistics,summaryDetail';
  const json = await yfFetch(`v10/finance/quoteSummary/${yfSym}`, { modules });

  const s = json?.quoteSummary?.result?.[0];
  if (!s) return null;

  const trend      = s.recommendationTrend?.trend?.[0] ?? {};
  const strongBuy  = trend.strongBuy  ?? 0;
  const buy        = trend.buy        ?? 0;
  const hold       = trend.hold       ?? 0;
  const sell       = trend.sell       ?? 0;
  const strongSell = trend.strongSell ?? 0;
  const total      = strongBuy + buy + hold + sell + strongSell;
  const recKey     = s.financialData?.recommendationKey ?? '';
  const consensus  =
    recKey === 'strong_buy'   ? 'Sterk Kopen'   :
    recKey === 'buy'          ? 'Kopen'          :
    recKey === 'hold'         ? 'Houden'         :
    recKey === 'underperform' ? 'Onderpresteren' :
    recKey === 'sell'         ? 'Verkopen'       :
    total && (strongBuy + buy) / total > 0.55 ? 'Kopen' : 'Houden';

  const fd         = s.financialData ?? {};
  const avgTarget  = fd.targetMeanPrice?.raw  ?? null;
  const highTarget = fd.targetHighPrice?.raw  ?? null;
  const lowTarget  = fd.targetLowPrice?.raw   ?? null;
  const curPrice   = fd.currentPrice?.raw     ?? null;

  const upgrades = (s.upgradeDowngradeHistory?.history ?? [])
    .sort((a, b) => b.epochGradeDate - a.epochGradeDate)
    .slice(0, 8)
    .map(h => ({
      gradeDate: new Date(h.epochGradeDate * 1000).toISOString().split('T')[0],
      firm:      h.firm,
      action:    h.action,
      fromGrade: h.fromGrade,
      toGrade:   h.toGrade,
      actionNl:
        h.action === 'up'   ? '↑ Upgrade'   :
        h.action === 'down' ? '↓ Downgrade' :
        h.action === 'init' ? '▶ Initiatie'  : '→ Herbevestigd',
    }));

  const ks = s.defaultKeyStatistics ?? {};
  const sd = s.summaryDetail        ?? {};
  const ratiosLive = {};
  if (curPrice && ks.trailingEps?.raw)
    ratiosLive['P/E (TTM)']     = (curPrice / ks.trailingEps.raw).toFixed(1) + '×';
  if (ks.forwardPE?.fmt)          ratiosLive['P/E Fwd']       = ks.forwardPE.fmt;
  if (ks.enterpriseToEbitda?.fmt) ratiosLive['EV/EBITDA']     = ks.enterpriseToEbitda.fmt;
  if (ks.priceToSalesTrailing12Months?.fmt)
                                  ratiosLive['P/S']           = ks.priceToSalesTrailing12Months.fmt;
  if (fd.grossMargins?.fmt)       ratiosLive['Brutomarge']    = fd.grossMargins.fmt;
  if (fd.operatingMargins?.fmt)   ratiosLive['Bedrijfsmarge'] = fd.operatingMargins.fmt;
  if (fd.returnOnEquity?.fmt)     ratiosLive['ROE']           = fd.returnOnEquity.fmt;
  if (ks.beta?.fmt)               ratiosLive['Beta']          = ks.beta.fmt;
  if (sd.dividendYield?.fmt)      ratiosLive['Div. Yield']    = sd.dividendYield.fmt;
  if (ks.marketCap?.fmt)          ratiosLive['Mktcap']        = ks.marketCap.fmt;
  if (ks.debtToEquity?.fmt)       ratiosLive['Schuld/EV']     = ks.debtToEquity.fmt;
  if (ks.fiftyTwoWeekHigh?.raw)   ratiosLive['52w Hoog']      = String(ks.fiftyTwoWeekHigh.raw);
  if (ks.fiftyTwoWeekLow?.raw)    ratiosLive['52w Laag']      = String(ks.fiftyTwoWeekLow.raw);

  const out = {
    consensus, strongBuy, buy, hold, sell, strongSell, total,
    avgTarget, highTarget, lowTarget, currentPrice: curPrice,
    recKey, upgrades, ratiosLive,
    pe:         curPrice && ks.trailingEps?.raw ? +(curPrice / ks.trailingEps.raw).toFixed(1) : null,
    forwardPE:  ks.forwardPE?.raw    ?? null,
    beta:       ks.beta?.raw         ?? null,
    divYield:   sd.dividendYield?.raw ? +(sd.dividendYield.raw * 100).toFixed(2) : null,
    roe:        fd.returnOnEquity?.raw ? +(fd.returnOnEquity.raw * 100).toFixed(1) : null,
    week52High: ks.fiftyTwoWeekHigh?.raw ?? null,
    week52Low:  ks.fiftyTwoWeekLow?.raw  ?? null,
  };

  dcSet(key, out, 6 * 60 * 60 * 1000);
  return out;
}

// ─── ANTHROPIC AI: ACTUEEL NIEUWS PER AANDEEL ────────────────────────────────
function setAnthropicKey(key) {
  if (key?.startsWith('sk-ant-')) {
    localStorage.setItem('pf_ant_key', key);
    console.log('✓ Anthropic API key opgeslagen');
    if (typeof showDbStatus === 'function')
      showDbStatus('✓ Anthropic key opgeslagen — AI nieuws actief', 'green');
    return true;
  }
  console.warn('Ongeldige key — moet starten met sk-ant-');
  return false;
}

async function fetchAINews(ticker) {
  const key = 'news_ai_' + ticker;
  const cached = dcGet(key);
  if (cached) return cached;

  const apiKey = localStorage.getItem('pf_ant_key');
  if (!apiKey) return null;

  const s = STOCKS[ticker];
  if (!s) return null;

  const today = new Date().toLocaleDateString('nl-BE', { day: 'numeric', month: 'long', year: 'numeric' });
  const price = s.price ? s.price.toFixed(2) : '—';
  const chg   = s.chgNum != null ? (s.chgNum >= 0 ? '+' : '') + s.chgNum.toFixed(2) + '%' : '—';

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        system: `Je bent een financieel analist die actueel beleggersnieuws schrijft. Vandaag is ${today}. Huidige koers ${ticker}: ${price} (${chg}).
Zoek het meest recente nieuws voor ${s.full || s.name} (${ticker}) van de laatste 4 weken.
Antwoord UITSLUITEND met geldige JSON zonder markdown of extra tekst:
{"news":[{"badge":"nb-earn","bl":"CATEGORIE · ONDERWERP","date":"datum","time":"","title":"Nieuwstitel max 100 tekens","body":"2-3 zinnen met <strong>vetgedrukte</strong> kernwoorden."}]}
Badges: nb-earn=earnings/resultaten, nb-risk=risico/negatief, nb-cat=katalysator/positief, nb-corp=bedrijfsnieuws, nb-ana=analyst upgrade/downgrade.
Genereer 3 tot 4 items. Schrijf in het Nederlands.`,
        messages: [{ role: 'user', content: `Geef de 3-4 meest actuele en relevante nieuwsitems voor ${s.full || s.name} (${ticker}).` }],
      }),
    });

    if (!res.ok) { console.warn('Anthropic fout:', res.status); return null; }
    const data  = await res.json();
    const text  = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const news  = JSON.parse(clean).news ?? [];
    if (news.length) {
      dcSet(key, news, 6 * 60 * 60 * 1000);
      return news;
    }
    return null;
  } catch (e) {
    console.warn(`AI nieuws fout voor ${ticker}:`, e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERRIDES — vervangen de originele functies uit index.html
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchOneTicker(origTicker) {
  const yfSym = YF_SYM_MAP[origTicker] || origTicker;
  try {
    const q = await yfQuote(yfSym);
    return {
      price: q.price, chgAbs: q.chgAbs, chgPct: q.chgPct,
      prevClose: q.prevClose, dayHigh: q.dayHigh, dayLow: q.dayLow,
      wkHigh: q.wkHigh, wkLow: q.wkLow, currency: q.currency,
      name: q.name, exchange: q.exchange, mktCap: q.mktCap,
      pe: null, targetLow: null, targetMean: null, targetHigh: null,
      numAnalysts: null, recKey: null,
      strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0,
    };
  } catch (e) {
    throw new Error(`${origTicker}: ${e.message}`);
  }
}

async function fetchHistory(ticker, period) {
  const yfSym = YF_SYM_MAP[ticker] || ticker;
  return yfHistory(yfSym, period);
}

async function fetchAnalystData(ticker) {
  if (analystCache[ticker]) return analystCache[ticker];

  const yfSym = YF_SYM_MAP[ticker] || ticker;
  const data  = await yfAnalyst(yfSym);
  if (!data) return null;

  const s = STOCKS[ticker];
  if (s) {
    if (data.total > 0) {
      s.analysts = s.analysts || {};
      s.analysts.buy       = data.buy + data.strongBuy;
      s.analysts.hold      = data.hold;
      s.analysts.sell      = data.sell + data.strongSell;
      s.analysts.total     = data.total;
      s.analysts.consensus = data.consensus;
      if (data.avgTarget)  s.analysts.avgTarget  = Math.round(data.avgTarget);
      if (data.highTarget) s.analysts.highTarget = Math.round(data.highTarget);
      if (data.lowTarget)  s.analysts.lowTarget  = Math.round(data.lowTarget);
    }
    s.ratios = { ...s.ratios, ...data.ratiosLive };
    if (data.week52High) s.wkH = data.week52High;
    if (data.week52Low)  s.wkL = data.week52Low;
  }

  const result = {
    analystSummary: {
      buy: data.buy + data.strongBuy, hold: data.hold,
      sell: data.sell + data.strongSell, total: data.total,
      strongBuy: data.strongBuy, strongSell: data.strongSell,
      consensus: data.consensus,
      avgTarget:  data.avgTarget  ? Math.round(data.avgTarget)  : null,
      highTarget: data.highTarget ? Math.round(data.highTarget) : null,
      lowTarget:  data.lowTarget  ? Math.round(data.lowTarget)  : null,
    },
    upgrades: data.upgrades,
    overview: {
      pe: data.pe, forwardPE: data.forwardPE, beta: data.beta,
      divYield: data.divYield, roe: data.roe,
      targetPrice: data.avgTarget,
      week52High: data.week52High, week52Low: data.week52Low,
    },
  };

  analystCache[ticker] = result;

  // AI nieuws op achtergrond ophalen
  fetchAINews(ticker).then(news => {
    if (news?.length && STOCKS[ticker]) {
      newsCache[ticker] = { items: news, _isAI: true };
      if (typeof activeStock !== 'undefined' && activeStock === ticker &&
          typeof activePage  !== 'undefined' && activePage  === 'detail' &&
          typeof renderDetail === 'function') {
        renderDetail(ticker);
      }
    }
  });

  return result;
}


async function fetchNewsForTicker(ticker) {
  if (newsCache[ticker]) return newsCache[ticker];
  return null;
}

async function fetchWlNews(ticker) {
  if (wlNewsCache[ticker]) return wlNewsCache[ticker];
  return null;
}

console.log('✓ src/data.js geladen — Yahoo Finance via Worker actief');
console.log('  Worker URL:', YF_WORKER);
console.log('  AI nieuws instellen: setAnthropicKey("sk-ant-api03-...")');
