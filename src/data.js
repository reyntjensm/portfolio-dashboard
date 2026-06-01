// ═══════════════════════════════════════════════════════════════════════════════
// src/data.js — Live data via Yahoo Finance + AI nieuws via Anthropic
// Dit bestand VERVANGT alle Alpha Vantage en Finnhub calls in index.html.
// Voeg onderaan index.html toe (net voor </body>):
//   <script src="src/data.js"></script>
// ═══════════════════════════════════════════════════════════════════════════════

// ─── CONFIGURATIE ─────────────────────────────────────────────────────────────
const YF_WORKER = 'https://portfolio-dashboard.reyntjensm.workers.dev/yf';

// Yahoo Finance ticker mapping (portfolio ticker → YF ticker)
const YF_SYM_MAP = {
  AAPL: 'AAPL', GOOGL: 'GOOGL',
  ACKB: 'AKA.BR', SOF: 'SOF.BR', IFX: 'IFX.DE',
  // Watchlist / extra tickers: voeg hier toe indien nodig
  // NVDA:'NVDA', MSFT:'MSFT', ASML:'ASML.AS', KBC:'KBC.BR',
};

// Yahoo Finance periodes voor grafieken
const YF_HIST_CFG = {
  '15M': { range: '1d',  interval: '5m'   },
  '1U':  { range: '5d',  interval: '30m'  },
  '1M':  { range: '1mo', interval: '1d'   },
  '3M':  { range: '3mo', interval: '1d'   },
  '6M':  { range: '6mo', interval: '1d'   },
  '1J':  { range: '1y',  interval: '1d'   },
  '2J':  { range: '2y',  interval: '1wk'  },
  '5J':  { range: '5y',  interval: '1mo'  },
  'MAX': { range: 'max', interval: '1mo'  },
};

// In-memory cache
const _dc = {};
function dcGet(k) {
  const e = _dc[k];
  if (!e || Date.now() - e.ts > e.ttl) return null;
  return e.v;
}
function dcSet(k, v, ttl) { _dc[k] = { v, ts: Date.now(), ttl }; }

// ─── YAHOO FINANCE: QUOTE (realtime koers) ────────────────────────────────────
async function yfQuote(yfSym) {
  const cacheKey = 'q_' + yfSym;
  const cached = dcGet(cacheKey);
  if (cached) return cached;

  const url = `${YF_WORKER}?endpoint=v8/finance/chart/${encodeURIComponent(yfSym)}&interval=1d&range=1d`;
  const fallback = `https://api.allorigins.win/raw?url=${encodeURIComponent(
    `https://query1.finance.yahoo.com/v8/finance/chart/${yfSym}?interval=1d&range=1d`
  )}`;

  for (const u of [url, fallback]) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      if (!result) continue;
      const m = result.meta;
      const price    = m.regularMarketPrice ?? m.previousClose ?? 0;
      const prev     = m.previousClose ?? m.chartPreviousClose ?? price;
      const chgAbs   = +(price - prev).toFixed(4);
      const chgPct   = prev ? +(((price - prev) / prev) * 100).toFixed(4) : 0;
      const isEU     = yfSym.includes('.') && !yfSym.endsWith('=X');
      const out = {
        price, chgAbs, chgPct,
        prevClose: prev,
        dayHigh:   m.regularMarketDayHigh  ?? null,
        dayLow:    m.regularMarketDayLow   ?? null,
        wkHigh:    m.fiftyTwoWeekHigh      ?? null,
        wkLow:     m.fiftyTwoWeekLow       ?? null,
        volume:    m.regularMarketVolume   ?? null,
        mktCap:    m.marketCap             ?? null,
        currency:  m.currency              ?? (isEU ? 'EUR' : 'USD'),
        exchange:  m.exchangeName          ?? '',
        name:      m.longName ?? m.shortName ?? yfSym,
        // Geen analyst data in chart endpoint — komt via quoteSummary
        pe: null, targetLow: null, targetMean: null, targetHigh: null,
        numAnalysts: null, recKey: null,
        strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0,
        error: null,
      };
      dcSet(cacheKey, out, 5 * 60 * 1000); // 5 min
      return out;
    } catch (e) { /* probeer volgende */ }
  }
  return { error: 'Quote niet beschikbaar', price: 0, chgPct: 0, chgAbs: 0 };
}

// ─── YAHOO FINANCE: HISTORISCHE DATA (grafieken) ──────────────────────────────
async function yfHistory(yfSym, period) {
  const cacheKey = 'h_' + yfSym + '_' + period;
  const cached = dcGet(cacheKey);
  if (cached) return cached;

  const cfg = YF_HIST_CFG[period] || YF_HIST_CFG['1J'];
  const params = `range=${cfg.range}&interval=${cfg.interval}`;
  const url = `${YF_WORKER}?endpoint=v8/finance/chart/${encodeURIComponent(yfSym)}&${params}`;
  const fallback = `https://api.allorigins.win/raw?url=${encodeURIComponent(
    `https://query1.finance.yahoo.com/v8/finance/chart/${yfSym}?${params}`
  )}`;

  for (const u of [url, fallback]) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      if (!result) continue;
      const ts  = result.timestamp ?? [];
      const q   = result.indicators?.quote?.[0] ?? {};
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

      if (!candles.length) continue;
      const ttl = ['15M','1U'].includes(period) ? 5*60*1000 : 24*60*60*1000;
      dcSet(cacheKey, candles, ttl);
      return candles;
    } catch (e) { /* probeer volgende */ }
  }
  throw new Error(`Geen historische data voor ${yfSym} (${period})`);
}

// ─── YAHOO FINANCE: ANALYST + RATIOS (quoteSummary) ──────────────────────────
async function yfAnalyst(yfSym, ticker) {
  const cacheKey = 'a_' + yfSym;
  const cached = dcGet(cacheKey);
  if (cached) return cached;

  const modules = 'recommendationTrend,upgradeDowngradeHistory,financialData,defaultKeyStatistics,summaryDetail';
  const url = `${YF_WORKER}?endpoint=v10/finance/quoteSummary/${encodeURIComponent(yfSym)}&modules=${modules}`;
  const fallback = `https://api.allorigins.win/raw?url=${encodeURIComponent(
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${yfSym}?modules=${modules}`
  )}`;

  for (const u of [url, fallback]) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const j = await r.json();
      const s = j?.quoteSummary?.result?.[0];
      if (!s) continue;

      // Aanbevelingen
      const trend = s.recommendationTrend?.trend?.[0];
      const strongBuy  = trend?.strongBuy  ?? 0;
      const buy        = trend?.buy        ?? 0;
      const hold       = trend?.hold       ?? 0;
      const sell       = trend?.sell       ?? 0;
      const strongSell = trend?.strongSell ?? 0;
      const totalRec   = strongBuy + buy + hold + sell + strongSell || 1;
      const recKey     = s.financialData?.recommendationKey ?? '';
      const consensus  =
        recKey === 'strong_buy'   ? 'Sterk Kopen'  :
        recKey === 'buy'          ? 'Kopen'         :
        recKey === 'hold'         ? 'Houden'        :
        recKey === 'underperform' ? 'Onderpresteren':
        recKey === 'sell'         ? 'Verkopen'      :
        (strongBuy+buy)/totalRec > 0.55 ? 'Kopen'  : 'Houden';

      // Koersdoelen
      const fd = s.financialData ?? {};
      const avgTarget  = fd.targetMeanPrice?.raw  ?? null;
      const highTarget = fd.targetHighPrice?.raw  ?? null;
      const lowTarget  = fd.targetLowPrice?.raw   ?? null;

      // Upgrades/downgrades (laatste 8)
      const upgrades = (s.upgradeDowngradeHistory?.history ?? [])
        .sort((a, b) => b.epochGradeDate - a.epochGradeDate)
        .slice(0, 8)
        .map(h => ({
          gradeDate:  new Date(h.epochGradeDate * 1000).toISOString().split('T')[0],
          firm:       h.firm,
          action:     h.action,
          fromGrade:  h.fromGrade,
          toGrade:    h.toGrade,
          actionNl:   h.action === 'up'   ? '↑ Upgrade'   :
                      h.action === 'down' ? '↓ Downgrade' :
                      h.action === 'init' ? '▶ Initiatie'  : '→ Herbevestigd',
        }));

      // Key stats + ratios
      const ks = s.defaultKeyStatistics ?? {};
      const sd = s.summaryDetail       ?? {};
      const currentPrice = fd.currentPrice?.raw ?? null;

      const ratiosLive = {};
      if (fd.grossMargins?.fmt)             ratiosLive['Brutomarge']      = fd.grossMargins.fmt;
      if (fd.operatingMargins?.fmt)         ratiosLive['Bedrijfsmarge']   = fd.operatingMargins.fmt;
      if (fd.returnOnEquity?.fmt)           ratiosLive['ROE']             = fd.returnOnEquity.fmt;
      if (ks.trailingEps?.raw && currentPrice)
        ratiosLive['P/E (TTM)'] = (currentPrice / ks.trailingEps.raw).toFixed(1) + '×';
      if (ks.forwardPE?.fmt)                ratiosLive['P/E Fwd']         = ks.forwardPE.fmt;
      if (ks.enterpriseToEbitda?.fmt)       ratiosLive['EV/EBITDA']       = ks.enterpriseToEbitda.fmt;
      if (ks.priceToSalesTrailing12Months?.fmt) ratiosLive['P/S']         = ks.priceToSalesTrailing12Months.fmt;
      if (ks.beta?.fmt)                     ratiosLive['Beta']            = ks.beta.fmt;
      if (sd.dividendYield?.fmt)            ratiosLive['Div. Yield']      = sd.dividendYield.fmt;
      if (ks.marketCap?.fmt)                ratiosLive['Mktcap']          = ks.marketCap.fmt;
      if (ks.debtToEquity?.fmt)             ratiosLive['Schuld/EV']       = ks.debtToEquity.fmt;
      if (ks.fiftyTwoWeekHigh?.raw)         ratiosLive['52w Hoog']        = String(ks.fiftyTwoWeekHigh.raw);
      if (ks.fiftyTwoWeekLow?.raw)          ratiosLive['52w Laag']        = String(ks.fiftyTwoWeekLow.raw);

      const out = {
        consensus, strongBuy, buy, hold, sell, strongSell,
        total: strongBuy + buy + hold + sell + strongSell,
        avgTarget, highTarget, lowTarget, currentPrice,
        recKey, upgrades, ratiosLive,
        pe:       ks.trailingEps?.raw && currentPrice ? +(currentPrice/ks.trailingEps.raw).toFixed(1) : null,
        forwardPE:ks.forwardPE?.raw ?? null,
        beta:     ks.beta?.raw ?? null,
        divYield: sd.dividendYield?.raw ? +(sd.dividendYield.raw * 100).toFixed(2) : null,
        roe:      fd.returnOnEquity?.raw ? +(fd.returnOnEquity.raw * 100).toFixed(1) : null,
        week52High: ks.fiftyTwoWeekHigh?.raw ?? null,
        week52Low:  ks.fiftyTwoWeekLow?.raw  ?? null,
      };

      dcSet(cacheKey, out, 6 * 60 * 60 * 1000); // 6u
      return out;
    } catch (e) { /* probeer volgende */ }
  }
  return null;
}

// ─── ANTHROPIC AI: NIEUWS PER AANDEEL ────────────────────────────────────────
// API key instellen: setAnthropicKey('sk-ant-api03-...')  (eenmalig in console)
function setAnthropicKey(key) {
  if (key?.startsWith('sk-ant-')) {
    localStorage.setItem('pf_ant_key', key);
    console.log('✓ Anthropic API key opgeslagen');
    return true;
  }
  console.warn('Ongeldige key — moet starten met sk-ant-');
  return false;
}

async function fetchAINews(ticker) {
  const cacheKey = 'news_' + ticker;
  const cached = dcGet(cacheKey);
  if (cached) return cached;

  const apiKey = localStorage.getItem('pf_ant_key');
  if (!apiKey) return null; // Geen key → gebruik hardcoded nieuws uit STOCK_META

  const s = STOCKS[ticker];
  if (!s) return null;
  const today = new Date().toLocaleDateString('nl-BE', { day:'numeric', month:'long', year:'numeric' });
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
        system: `Je bent een financieel analist. Vandaag is ${today}. Koers ${ticker}: ${price} (${chg}).
Zoek het meest actuele nieuws voor ${s.full || s.name} (${ticker}).
Antwoord UITSLUITEND met geldige JSON zonder markdown of extra tekst, exact dit formaat:
{"news":[{"badge":"nb-earn","bl":"CATEGORIE · ONDERWERP","date":"datum","time":"","title":"Max 100 tekens","body":"2-3 zinnen met <strong>vetgedrukte</strong> kernwoorden."}]}
Badges: nb-earn=earnings, nb-risk=risico, nb-cat=katalysator/positief, nb-corp=bedrijfsnieuws, nb-ana=analyst.
Genereer 3-4 items. Focus op nieuws van de laatste 4 weken.`,
        messages: [{ role: 'user', content: `Meest actuele nieuwsitems voor ${s.full || s.name} (${ticker})?` }],
      }),
    });

    if (!res.ok) { console.warn('Anthropic fout:', res.status); return null; }
    const data = await res.json();
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    const news = parsed.news ?? [];
    if (news.length) {
      dcSet(cacheKey, news, 6 * 60 * 60 * 1000); // 6u cache
      return news;
    }
    return null;
  } catch (e) {
    console.warn(`AI nieuws fout voor ${ticker}:`, e.message);
    return null;
  }
}

// ─── OVERRIDE: fetchOneTicker (was Alpha Vantage + Finnhub) ──────────────────
// Wordt aangeroepen door fetchAllQuotes() in index.html — zelfde interface houden
async function fetchOneTicker(origTicker) {
  const yfSym = YF_SYM_MAP[origTicker] || origTicker;
  const q = await yfQuote(yfSym);
  if (q.error && q.price === 0) throw new Error(q.error);
  return {
    price:       q.price,
    chgAbs:      q.chgAbs,
    chgPct:      q.chgPct,
    prevClose:   q.prevClose,
    dayHigh:     q.dayHigh,
    dayLow:      q.dayLow,
    wkHigh:      q.wkHigh,
    wkLow:       q.wkLow,
    currency:    q.currency,
    name:        q.name,
    exchange:    q.exchange,
    mktCap:      q.mktCap,
    // Analyst velden komen via fetchAnalystData — hier null teruggeven
    pe: null, targetLow: null, targetMean: null, targetHigh: null,
    numAnalysts: null, recKey: null,
    strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0,
  };
}

// ─── OVERRIDE: fetchHistory (was Alpha Vantage) ───────────────────────────────
// Wordt aangeroepen door renderDetail in index.html — zelfde interface houden
async function fetchHistory(ticker, period) {
  const yfSym = YF_SYM_MAP[ticker] || ticker;
  return yfHistory(yfSym, period);
  // Geeft array van candles terug: [{t, o, h, l, c, v}, ...]
  // Exact hetzelfde formaat als de Alpha Vantage versie in index.html
}

// ─── OVERRIDE: fetchAnalystData (was Finnhub + Alpha Vantage) ─────────────────
// Wordt aangeroepen door renderDetail en refreshAnalystUI in index.html
async function fetchAnalystData(ticker) {
  if (analystCache[ticker]) return analystCache[ticker];

  const yfSym = YF_SYM_MAP[ticker] || ticker;
  const data = await yfAnalyst(yfSym, ticker);
  if (!data) return null;

  // Patch STOCKS direct (zelfde als originele fetchAnalystData)
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
    // Ratios updaten
    s.ratios = { ...s.ratios, ...data.ratiosLive };
    // 52w updaten
    if (data.week52High) s.wkH = data.week52High;
    if (data.week52Low)  s.wkL = data.week52Low;
  }

  // Upgrades in hetzelfde formaat als origineel (Finnhub-formaat)
  const result = {
    analystSummary: {
      buy:        data.buy + data.strongBuy,
      hold:       data.hold,
      sell:       data.sell + data.strongSell,
      total:      data.total,
      strongBuy:  data.strongBuy,
      strongSell: data.strongSell,
      consensus:  data.consensus,
      avgTarget:  data.avgTarget ? Math.round(data.avgTarget) : null,
      highTarget: data.highTarget ? Math.round(data.highTarget) : null,
      lowTarget:  data.lowTarget ? Math.round(data.lowTarget) : null,
    },
    upgrades: data.upgrades,
    overview: {
      pe:         data.pe,
      forwardPE:  data.forwardPE,
      beta:       data.beta,
      divYield:   data.divYield,
      roe:        data.roe,
      targetPrice:data.avgTarget,
      week52High: data.week52High,
      week52Low:  data.week52Low,
    },
  };

  analystCache[ticker] = result;

  // AI nieuws ophalen op achtergrond (blokkeert UI niet)
  fetchAINews(ticker).then(news => {
    if (news && news.length > 0 && STOCKS[ticker]) {
      newsCache[ticker] = { items: news, _isAI: true };
      // Re-render nieuws als dit aandeel actief is
      if (activeStock === ticker && activePage === 'detail') {
        renderDetail(ticker);
      }
    }
  });

  return result;
}

// ─── OVERRIDE: fetchNewsForTicker (was newsdata.io) ──────────────────────────
// Wordt aangeroepen bij renderDetail — geeft null terug zodat de hardcoded
// nieuws in STOCK_META wordt gebruikt totdat AI nieuws klaar is
async function fetchNewsForTicker(ticker) {
  if (newsCache[ticker]) return newsCache[ticker];
  // AI nieuws wordt getriggerd via fetchAnalystData → fetchAINews
  // Hier teruggeven we null zodat de bestaande hardcoded news items zichtbaar blijven
  return null;
}

// ─── OVERRIDE: fetchWlNews (was Finnhub) ─────────────────────────────────────
async function fetchWlNews(ticker) {
  if (wlNewsCache[ticker]) return wlNewsCache[ticker];
  // Watchlist nieuws via Finnhub was toch beperkt — geef null terug
  return null;
}

console.log('✓ src/data.js geladen — Yahoo Finance actief, AI nieuws klaar');
