// ═══════════════════════════════════════════════════════════════════════════════
// src/worker.js — Cloudflare Worker
// Gebruikt alleen Yahoo Finance endpoints die GEEN crumb/cookie nodig hebben:
// - v8/finance/chart     → koersen, historiek, 52w high/low
// - v6/finance/recommendationsBySymbol → analyst consensus (geen auth!)
// - v11/finance/quoteSummary → met crumb poging, fallback naar gecachte data
// ═══════════════════════════════════════════════════════════════════════════════

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname.startsWith('/yf')) {
      return handleProxy(url);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Portfolio Worker OK', { headers: corsHeaders() });
  }
};

async function handleProxy(url) {
  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) return jsonResponse({ error: 'Ontbrekende parameter: endpoint' }, 400);

  // Bepaal de juiste Yahoo Finance host
  // v6 en v8 → query1 (geen auth nodig)
  // v10/v11 → query2 (met crumb poging)
  const isAuth = endpoint.startsWith('v10/') || endpoint.startsWith('v11/');
  const host   = isAuth ? 'query2.finance.yahoo.com' : 'query1.finance.yahoo.com';

  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (k !== 'endpoint') params.set(k, v);
  }

  // Voor auth endpoints: probeer crumb op te halen
  let cookie = '';
  if (isAuth) {
    try {
      const auth = await fetchAuth();
      if (auth.crumb) params.set('crumb', auth.crumb);
      cookie = auth.cookie;
    } catch (e) {
      console.warn('Crumb ophalen mislukt:', e.message);
    }
  }

  const qs  = params.size ? '?' + params.toString() : '';
  const hdrs = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
  };
  if (cookie) hdrs['Cookie'] = cookie;

  try {
    const res = await fetch(`https://${host}/${endpoint}${qs}`, {
      headers: hdrs,
      cf: { cacheTtl: 300, cacheEverything: true }
    });

    if (!res.ok) return jsonResponse({ error: `Yahoo Finance ${res.status}` }, res.status);

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        ...corsHeaders()
      }
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function fetchAuth() {
  const r1 = await fetch('https://finance.yahoo.com', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
  });
  const setCookie = r1.headers.get('set-cookie') || '';
  const cookieParts = setCookie.split(/,\s*(?=[a-zA-Z0-9_\-]+=)/);
  const cookieMap = {};
  for (const part of cookieParts) {
    const nv = part.split(';')[0].trim();
    const eq = nv.indexOf('=');
    if (eq > 0) cookieMap[nv.slice(0, eq).trim()] = nv.slice(eq + 1).trim();
  }
  const cookieStr = Object.entries(cookieMap).map(([k,v]) => `${k}=${v}`).join('; ');

  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': cookieStr, 'Referer': 'https://finance.yahoo.com/' },
  });
  const crumb = r2.ok ? (await r2.text()).trim() : null;
  return { crumb: crumb && !crumb.includes('<') ? crumb : null, cookie: cookieStr };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}
