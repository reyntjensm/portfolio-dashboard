// ═══════════════════════════════════════════════════════════════════════════════
// src/data.js — Live data laag
// Koersen + grafieken : Yahoo Finance v8 (onbeperkt, geen auth)
// Analyst consensus   : Alpha Vantage OVERVIEW (25 calls/dag, 24u cache)
// AI nieuws           : Anthropic (optioneel, via setAnthropicKey())
// ═══════════════════════════════════════════════════════════════════════════════

const YF_WORKER  = 'https://portfolio-dashboard.michiel-0be.workers.dev/yf';
const AV_KEY     = 'YV7LYG7RHI1SPAS6';
const AV_MAX_DAY = 25; // Alpha Vantage gratis limiet per dag

// Yahoo Finance ticker mapping
const YF_SYM_MAP = {
  AAPL:  'AAPL',
  GOOGL: 'GOOG',
  ACKB:  'ACKB.BR',
  SOF:   'SOF.BR',
  IFX:   'IFX.DE',
};

// Alpha Vantage ticker mapping
const AV_SYM_MAP = {
  AAPL:  'AAPL',
  GOOGL: 'GOOGL',
  ACKB:  'AKA.BRU',
  SOF:   'SOF.BRU',
  IFX:   'IFX.DEX',
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

// ─── IN-MEMORY CACHE (verdwijnt bij refresh) ──────────────────────────────────
const _mem = {};
function memGet(k) {
  const e = _mem[k];
  if (!e || Date.now() - e.ts > e.ttl) return null;
  return e.v;
}
function memSet(k, v, ttl) { _mem[k] = { v, ts: Date.now(), ttl }; }

// ─── LOCALSTORAGE CACHE (blijft na refresh, 24u) ─────────────────────────────
function lsGet(k) {
  try {
    const raw = localStorage.getItem('pf_' + k);
    if (!raw) return null;
    const e = JSON.parse(raw);
    if (Date.now() - e.ts > e.ttl) { localStorage.removeItem('pf_' + k); return null; }
    return e.v;
  } catch(_) { return null; }
}
function lsSet(k, v, ttl) {
  try { localStorage.setItem('pf_' + k, JSON.stringify({ v, ts: Date.now(), ttl })); } catch(_) {}
}

// ─── ALPHA VANTAGE CALL TELLER ────────────────────────────────────────────────
// Houdt bij hoeveel AV calls vandaag al gemaakt zijn
function avCallsToday() {
  try {
    const raw = localStorage.getItem('pf_av_calls');
    if (!raw) return 0;
    const e = JSON.parse(raw);
    const today = new Date().toDateString();
    if (e.date !== today) return 0;
    return e.count || 0;
  } catch(_) { return 0; }
}

function avIncrementCalls() {
  try {
    const today = new Date().toDateString();
    const count = avCallsToday() + 1;
    localStorage.setItem('pf_av_calls', JSON.stringify({ date: today, count }));
    updateAvBadge(count);
    return count;
  } catch(_) { return 0; }
}

function avLimitReached() {
  return avCallsToday() >= AV_MAX_DAY;
}

// Toon badge in de UI over het aantal resterende AV calls
function updateAvBadge(used) {
  const remaining = AV_MAX_DAY - used;
  const pct = (used / AV_MAX_DAY) * 100;

  // Verwijder bestaande badge
  const existing = document.getElementById('av-limit-badge');
  if (existing) existing.remove();

  // Maak nieuwe badge
  const badge = document.createElement('div');
  badge.id = 'av-limit-badge';
  badge.style.cssText = `
    position:fixed; bottom:80px; right:12px; z-index:500;
    background:var(--s1); border:1px solid ${remaining <= 5 ? 'var(--red)' : remaining <= 10 ? 'var(--orange)' : 'var(--b1)'};
    border-radius:10px; padding:8px 12px; font-family:var(--mono); font-size:10px;
    color:${remaining <= 5 ? 'var(--red)' : remaining <= 10 ? 'var(--orange)' : 'var(--muted)'};
    box-shadow:0 4px 12px rgba(0,0,0,.3); cursor:pointer;
  `;
  badge.innerHTML = `
    <div style="font-weight:700;margin-bottom:3px;">Alpha Vantage</div>
    <div>${remaining <= 0 ? '⛔ Daglimiet bereikt' : `${remaining} / ${AV_MAX_DAY} calls resterend`}</div>
    <div style="height:3px;background:var(--b2);border-radius:2px;margin-top:5px;">
      <div style="height:100%;width:${pct}%;background:${remaining <= 5 ? 'var(--red)' : remaining <= 10 ? 'var(--orange)' : 'var(--green)'};border-radius:2px;transition:width .3s;"></div>
    </div>
    ${remaining <= 0 ? '<div style="margin-top:4px;font-size:9px;color:var(--muted);">Reset om middernacht</div>' : ''}
  `;
  // Klik om te verbergen
  badge.onclick = () => badge.remove();
  document.body.appendChild(badge);

  // Auto-verberg na 8 seconden (tenzij limiet bereikt)
  if (remaining > 0) {
    setTimeout(() => { if (document.getElementById('av-limit-badge')) badge.remove(); }, 8000);
  }
}

// Toon melding bij limiet bereikt
function showAvLimitWarning() {
  if (typeof showDbStatus === 'function') {
    showDbStatus('⛔ Alpha Vantage daglimiet bereikt (25/25). Analyst data wordt morgen vernieuwd.', 'orange');
  }
  updateAvBadge(AV_MAX_DAY);
}

// Initialiseer badge bij laden
document.addEventListener('DOMContentLoaded', () => {
  const used = avCallsToday();
  if (used > 0) updateAvBadge(used);
});

// ─── YAHOO FINANCE: REALTIME KOERS ───────────────────────────────────────────
async function yfQuote(yfSym) {
  const key = 'q_' + yfSym;
  const cached = memGet(key);
  if (cached) return cached;

  const url = `${YF_WORKER}?endpoint=v8/finance/chart/${encodeURIComponent(yfSym)}&interval=1d&range=1d`;
  const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Yahoo quote ${res.status} voor ${yfSym}`);

  const json   = await res.json();
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

  memSet(key, out, 5 * 60 * 1000); // 5 min
  return out;
}

// ─── YAHOO FINANCE: HISTORISCHE GRAFIEKDATA ───────────────────────────────────
async function yfHistory(yfSym, period) {
  const key    = 'h_' + yfSym + '_' + period;
  const cached = memGet(key);
  if (cached) return cached;

  // Probeer ook localStorage voor historische data
  const lsCached = lsGet('hist_' + yfSym + '_' + period);
  if (lsCached) { memSet(key, lsCached, 60 * 60 * 1000); return lsCached; }

  const cfg = YF_HIST_CFG[period] || YF_HIST_CFG['1J'];
  const url = `${YF_WORKER}?endpoint=v8/finance/chart/${encodeURIComponent(yfSym)}&range=${cfg.range}&interval=${cfg.interval}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Yahoo history ${res.status}`);

  const json   = await res.json();
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

  const isIntraday = ['15M', '1U'].includes(period);
  const ttl = isIntraday ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000;
  memSet(key, candles, ttl);
  if (!isIntraday) lsSet('hist_' + yfSym + '_' + period, candles, ttl);
  return candles;
}

// ─── ALPHA VANTAGE: ANALYST CONSENSUS + RATIOS ───────────────────────────────
// Gebruikt OVERVIEW endpoint — geeft P/E, beta, analyst ratings, koersdoel
// 24u localStorage cache zodat max 5 calls/dag voor 5 aandelen
async function avOverview(ticker) {
  const lsKey  = 'av_ov_' + ticker;
  const memKey = 'aov_' + ticker;

  // 1. Check memory cache
  const memCached = memGet(memKey);
  if (memCached) return memCached;

  // 2. Check localStorage cache (24u)
  const lsCached = lsGet(lsKey);
  if (lsCached) {
    memSet(memKey, lsCached, 60 * 60 * 1000);
    return lsCached;
  }

  // 3. Check AV daglimiet
  if (avLimitReached()) {
    showAvLimitWarning();
    return null;
  }

  // 4. Haal verse data op via Alpha Vantage
  const avSym = AV_SYM_MAP[ticker] || ticker;
  const url   = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(avSym)}&apikey=${AV_KEY}`;

  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`AV HTTP ${res.status}`);

    const d = await res.json();

    // Check op rate limit melding van Alpha Vantage
    if (d.Note || d.Information) {
      console.warn('Alpha Vantage rate limit:', d.Note || d.Information);
      // Stel teller in op maximum zodat we niet meer proberen
      localStorage.setItem('pf_av_calls', JSON.stringify({
        date: new Date().toDateString(),
        count: AV_MAX_DAY
      }));
      showAvLimitWarning();
      return null;
    }

    if (!d.Symbol) {
      console.warn('Alpha Vantage: geen data voor', avSym);
      return null;
    }

    // Verhoog teller
    avIncrementCalls();

    // Verwerk analyst data
    const buy   = parseInt(d.AnalystRatingStrongBuy || '0') + parseInt(d.AnalystRatingBuy || '0');
    const hold  = parseInt(d.AnalystRatingHold || '0');
    const sell  = parseInt(d.AnalystRatingSell || '0') + parseInt(d.AnalystRatingStrongSell || '0');
    const total = buy + hold + sell;
    const buyR  = total ? buy / total : 0;

    const consensus =
      buyR > 0.65  ? 'Sterk Kopen'   :
      buyR > 0.45  ? 'Kopen'         :
      sell/Math.max(total,1) > 0.4 ? 'Verkopen' : 'Houden';

    const avgTarget = d.AnalystTargetPrice ? parseFloat(d.AnalystTargetPrice) : null;
    const pe        = d.PERatio            ? parseFloat(d.PERatio)            : null;
    const forwardPE = d.ForwardPE          ? parseFloat(d.ForwardPE)          : null;
    const beta      = d.Beta               ? parseFloat(d.Beta)               : null;
    const divYield  = d.DividendYield      ? +(parseFloat(d.DividendYield) * 100).toFixed(2) : null;
    const roe       = d.ReturnOnEquityTTM  ? +(parseFloat(d.ReturnOnEquityTTM) * 100).toFixed(1) : null;
    const wk52H     = d['52WeekHigh']      ? parseFloat(d['52WeekHigh'])      : null;
    const wk52L     = d['52WeekLow']       ? parseFloat(d['52WeekLow'])       : null;
    const mktCap    = d.MarketCapitalization ? parseInt(d.MarketCapitalization) : null;

    const mktCapFmt = mktCap
      ? mktCap >= 1e12 ? (mktCap/1e12).toFixed(2)+'T'
      : mktCap >= 1e9  ? (mktCap/1e9).toFixed(1)+'B'
      :                   (mktCap/1e6).toFixed(0)+'M'
      : null;

    const ratiosLive = {};
    if (pe)       ratiosLive['P/E (TTM)']    = pe.toFixed(1) + '×';
    if (forwardPE)ratiosLive['P/E Fwd']      = forwardPE.toFixed(1) + '×';
    if (beta)     ratiosLive['Beta']          = beta.toFixed(2);
    if (divYield) ratiosLive['Div. Yield']    = divYield + '%';
    if (roe)      ratiosLive['ROE']           = roe + '%';
    if (mktCapFmt)ratiosLive['Mktcap']        = mktCapFmt;
    if (wk52H)    ratiosLive['52w Hoog']      = String(wk52H);
    if (wk52L)    ratiosLive['52w Laag']      = String(wk52L);
    if (d.GrossProfitTTM && d.RevenueTTM) {
      const gm = (parseInt(d.GrossProfitTTM) / parseInt(d.RevenueTTM) * 100).toFixed(1);
      ratiosLive['Brutomarge'] = gm + '%';
    }
    if (d.OperatingMarginTTM) {
      ratiosLive['Bedrijfsmarge'] = (parseFloat(d.OperatingMarginTTM) * 100).toFixed(1) + '%';
    }
    if (d.EVToEBITDA) ratiosLive['EV/EBITDA'] = parseFloat(d.EVToEBITDA).toFixed(1) + '×';
    if (d.PriceToSalesRatioTTM) ratiosLive['P/S'] = parseFloat(d.PriceToSalesRatioTTM).toFixed(1) + '×';

    const out = {
      consensus, buy, hold, sell, total,
      strongBuy: parseInt(d.AnalystRatingStrongBuy || '0'),
      strongSell: parseInt(d.AnalystRatingStrongSell || '0'),
      avgTarget, highTarget: null, lowTarget: null,
      pe, forwardPE, beta, divYield, roe,
      week52High: wk52H, week52Low: wk52L,
      ratiosLive,
      upgrades: [], // AV OVERVIEW geeft geen upgrade history
    };

    // Sla 24u op in localStorage
    lsSet(lsKey, out, 24 * 60 * 60 * 1000);
    memSet(memKey, out, 60 * 60 * 1000);
    return out;

  } catch(e) {
    console.warn(`Alpha Vantage OVERVIEW fout voor ${ticker}:`, e.message);
    return null;
  }
}

// ─── ANTHROPIC AI: ACTUEEL NIEUWS (optioneel) ─────────────────────────────────
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
  const key    = 'news_ai_' + ticker;
  const cached = lsGet(key);
  if (cached) return cached;

  const apiKey = localStorage.getItem('pf_ant_key');
  if (!apiKey) return null;

  const s     = STOCKS[ticker];
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
Zoek het meest recente nieuws voor ${s.full || s.name} (${ticker}) van de laatste 4 weken.
Antwoord UITSLUITEND met geldige JSON zonder markdown:
{"news":[{"badge":"nb-earn","bl":"CATEGORIE · ONDERWERP","date":"datum","time":"","title":"Max 100 tekens","body":"2-3 zinnen met <strong>vetgedrukte</strong> kernwoorden."}]}
Badges: nb-earn=earnings, nb-risk=risico, nb-cat=katalysator, nb-corp=bedrijfsnieuws, nb-ana=analyst.
Genereer 3-4 items in het Nederlands.`,
        messages: [{ role:'user', content:`Meest actuele nieuwsitems voor ${s.full || s.name} (${ticker})?` }],
      }),
    });
    if (!res.ok) return null;
    const data  = await res.json();
    const text  = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const news  = JSON.parse(text.replace(/```json|```/g,'').trim()).news ?? [];
    if (news.length) { lsSet(key, news, 6 * 60 * 60 * 1000); return news; }
    return null;
  } catch(e) {
    console.warn(`AI nieuws fout voor ${ticker}:`, e.message);
    return null;
  }
}


// ─── ALPHA VANTAGE: NIEUWS PER AANDEEL ───────────────────────────────────────
// Gratis endpoint — telt mee voor de 25 calls/dag limiet
async function avNews(ticker) {
  const lsKey  = 'av_news_' + ticker;
  const memKey = 'anews_' + ticker;

  const memCached = memGet(memKey);
  if (memCached) return memCached;

  const lsCached = lsGet(lsKey);
  if (lsCached) { memSet(memKey, lsCached, 60 * 60 * 1000); return lsCached; }

  if (avLimitReached()) return null;

  const avSym = AV_SYM_MAP[ticker] || ticker;
  const url   = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(avSym)}&limit=4&apikey=${AV_KEY}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const d = await res.json();

    if (d.Note || d.Information) {
      localStorage.setItem('pf_av_calls', JSON.stringify({ date: new Date().toDateString(), count: AV_MAX_DAY }));
      showAvLimitWarning();
      return null;
    }

    avIncrementCalls();

    const items = (d.feed || []).slice(0, 4).map(item => {
      const score = parseFloat(item.overall_sentiment_score || '0');
      const badge = score > 0.15 ? 'nb-cat' : score < -0.15 ? 'nb-risk' : 'nb-corp';
      const bl    = item.topics?.[0]?.topic
        ? item.topics[0].topic.toUpperCase().replace(/_/g, ' ')
        : 'NIEUWS';
      const date  = item.time_published
        ? new Date(item.time_published.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$3/$2/$1')).toLocaleDateString('nl-BE', {day:'numeric',month:'short',year:'numeric'})
        : '';
      return {
        badge,
        bl: bl + ' · ' + (item.source || ''),
        date,
        time: '',
        title: item.title || '',
        body:  item.summary || '',
        url:   item.url || '',
      };
    });

    if (items.length) {
      lsSet(lsKey, items, 6 * 60 * 60 * 1000); // 6u cache
      memSet(memKey, items, 60 * 60 * 1000);
      return items;
    }
    return null;
  } catch(e) {
    console.warn(`AV nieuws fout voor ${ticker}:`, e.message);
    return null;
  }
}

// ─── ALPHA VANTAGE: EARNINGS DATUM ───────────────────────────────────────────
async function avEarnings(ticker) {
  const lsKey = 'av_earn_' + ticker;
  const cached = lsGet(lsKey);
  if (cached) return cached;

  if (avLimitReached()) return null;

  const avSym = AV_SYM_MAP[ticker] || ticker;
  const url   = `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&symbol=${encodeURIComponent(avSym)}&horizon=3month&apikey=${AV_KEY}`;

  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.includes('Note') || text.includes('Information')) {
      localStorage.setItem('pf_av_calls', JSON.stringify({ date: new Date().toDateString(), count: AV_MAX_DAY }));
      showAvLimitWarning();
      return null;
    }

    avIncrementCalls();

    // CSV formaat: symbol,name,reportDate,fiscalDateEnding,estimate,currency
    const lines = text.trim().split('\n').slice(1); // sla header over
    for (const line of lines) {
      const parts = line.split(',');
      if (parts[0] === avSym && parts[2]) {
        const date = new Date(parts[2]);
        const formatted = date.toLocaleDateString('nl-BE', { day:'numeric', month:'long', year:'numeric' });
        const result = { date: formatted, raw: parts[2] };
        lsSet(lsKey, result, 24 * 60 * 60 * 1000);
        return result;
      }
    }
    return null;
  } catch(e) {
    console.warn(`AV earnings fout voor ${ticker}:`, e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERRIDES — vervangen de originele functies uit index.html
// ═══════════════════════════════════════════════════════════════════════════════

// Vervangt fetchOneTicker (was Alpha Vantage GLOBAL_QUOTE + Finnhub)
async function fetchOneTicker(origTicker) {
  const yfSym = YF_SYM_MAP[origTicker] || origTicker;
  const q = await yfQuote(yfSym);
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
    pe:          null,
    targetLow:   null,
    targetMean:  null,
    targetHigh:  null,
    numAnalysts: null,
    recKey:      null,
    strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0,
  };
}

// Vervangt fetchHistory (was Alpha Vantage TIME_SERIES)
async function fetchHistory(ticker, period) {
  const yfSym = YF_SYM_MAP[ticker] || ticker;
  return yfHistory(yfSym, period);
}

// Vervangt fetchAnalystData (was Finnhub + Alpha Vantage)
async function fetchAnalystData(ticker) {
  if (analystCache[ticker]) return analystCache[ticker];

  const data = await avOverview(ticker);
  if (!data) return null;

  // Patch STOCKS direct
  const s = STOCKS[ticker];
  if (s) {
    if (data.total > 0) {
      s.analysts = s.analysts || {};
      s.analysts.buy       = data.buy;
      s.analysts.hold      = data.hold;
      s.analysts.sell      = data.sell;
      s.analysts.total     = data.total;
      s.analysts.consensus = data.consensus;
      if (data.avgTarget) s.analysts.avgTarget = Math.round(data.avgTarget);
    }
    s.ratios = { ...s.ratios, ...data.ratiosLive };
    if (data.week52High) s.wkH = data.week52High;
    if (data.week52Low)  s.wkL = data.week52Low;
  }

  const result = {
    analystSummary: {
      buy:        data.buy,
      hold:       data.hold,
      sell:       data.sell,
      total:      data.total,
      strongBuy:  data.strongBuy,
      strongSell: data.strongSell,
      consensus:  data.consensus,
      avgTarget:  data.avgTarget ? Math.round(data.avgTarget) : null,
      highTarget: null,
      lowTarget:  null,
    },
    upgrades: [],
    overview: {
      pe:          data.pe,
      forwardPE:   data.forwardPE,
      beta:        data.beta,
      divYield:    data.divYield,
      roe:         data.roe,
      targetPrice: data.avgTarget,
      week52High:  data.week52High,
      week52Low:   data.week52Low,
    },
  };

  analystCache[ticker] = result;

  // Haal earnings datum op en update 'next' veld
  avEarnings(ticker).then(earn => {
    if (earn && STOCKS[ticker]) {
      STOCKS[ticker].next = 'Earnings ' + earn.date;
      STOCKS[ticker].nextIcon = '📋';
    }
  });

  // Re-render als actief
  if (typeof activeStock !== 'undefined' && activeStock === ticker &&
      typeof activePage  !== 'undefined' && activePage  === 'detail' &&
      typeof renderDetail === 'function') {
    renderDetail(ticker);
  }

  // AI nieuws op achtergrond (alleen als Anthropic key ingesteld)
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

// Vervangt fetchNewsForTicker — haalt nieuws via Alpha Vantage
async function fetchNewsForTicker(ticker) {
  if (newsCache[ticker]) return newsCache[ticker];

  // Probeer Alpha Vantage nieuws
  const news = await avNews(ticker);
  if (news?.length) {
    newsCache[ticker] = { items: news, _isAV: true };
    return newsCache[ticker];
  }
  return null;
}

// Vervangt fetchWlNews
async function fetchWlNews(ticker) {
  if (wlNewsCache?.[ticker]) return wlNewsCache[ticker];
  return null;
}

// Vervangt syncNow — wist ook de AV cache zodat verse data wordt opgehaald
const _origSyncNow = typeof syncNow === 'function' ? syncNow : null;
function syncNow() {
  // Wis analyst localStorage cache zodat AV opnieuw wordt aangeroepen
  Object.keys(STOCKS || {}).forEach(t => {
    localStorage.removeItem('pf_av_ov_' + t);
  });
  // Wis memory cache
  Object.keys(_mem).forEach(k => delete _mem[k]);

  if (_origSyncNow) return _origSyncNow();

  const btn = document.querySelector('.icon-btn[onclick="syncNow()"]');
  if (btn) btn.style.animation = 'spin 1s linear infinite';
  Promise.resolve()
    .then(() => typeof loadTickersFromDB === 'function' ? loadTickersFromDB() : null)
    .then(() => typeof refreshPrices === 'function' ? refreshPrices(false) : null)
    .finally(() => { if (btn) btn.style.animation = ''; });
}

console.log('✓ src/data.js geladen');
console.log('  Koersen: Yahoo Finance (onbeperkt)');
console.log('  Analyst: Alpha Vantage OVERVIEW (' + avCallsToday() + '/' + AV_MAX_DAY + ' calls vandaag)');
console.log('  AI nieuws: ' + (localStorage.getItem('pf_ant_key') ? 'actief' : 'inactief (setAnthropicKey("sk-ant-..."))'));
