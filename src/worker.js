// ═══════════════════════════════════════════════════════════════════════════════
// src/worker.js — Cloudflare Worker
// Crumb wordt opgeslagen via Cloudflare Cache API (persistent tussen requests)
// ═══════════════════════════════════════════════════════════════════════════════

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CACHE_KEY = 'https://portfolio-dashboard.internal/yfauth';

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

// ─── Crumb opslaan/ophalen via Cloudflare Cache API ──────────────────────────
async function saveAuth(crumb, cookie) {
  const cache = caches.default;
  const res = new Response(JSON.stringify({ crumb, cookie }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600', // 1 uur
    }
  });
  await cache.put(CACHE_KEY, res);
}

async function loadAuth() {
  const cache = caches.default;
  const cached = await cache.match(CACHE_KEY);
  if (cached) {
    try {
      return await cached.json();
    } catch (_) {}
  }
  return null;
}

// ─── Cookie + Crumb ophalen van Yahoo Finance ─────────────────────────────────
async function fetchFreshAuth() {
  // Stap 1: haal cookies op van Yahoo Finance
  const r1 = await fetch('https://finance.yahoo.com', {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    },
    redirect: 'follow',
  });

  // Lees set-cookie header — in Workers is dit één string
  const setCookieHeader = r1.headers.get('set-cookie') || '';
  
  // Extraheer naam=waarde paren (voor het eerste ; van elke cookie)
  // Cookies worden gescheiden door ", " maar alleen als er een nieuwe naam volgt
  const cookieMap = {};
  // Splits op ", " gevolgd door een cookie naam (letters/cijfers/underscore gevolgd door =)
  const cookieParts = setCookieHeader.split(/,\s*(?=[a-zA-Z0-9_\-]+=)/);
  for (const part of cookieParts) {
    const nameVal = part.split(';')[0].trim();
    const eqIdx = nameVal.indexOf('=');
    if (eqIdx > 0) {
      const name = nameVal.slice(0, eqIdx).trim();
      const val  = nameVal.slice(eqIdx + 1).trim();
      if (name) cookieMap[name] = val;
    }
  }
  const cookieStr = Object.entries(cookieMap).map(([k,v]) => `${k}=${v}`).join('; ');

  // Stap 2: haal crumb op met de cookies
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com/',
      'Origin': 'https://finance.yahoo.com',
      'Cookie': cookieStr,
    },
  });

  if (!r2.ok) throw new Error(`getcrumb HTTP ${r2.status}`);
  
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.length < 2 || crumb.includes('<') || crumb === 'null') {
    throw new Error(`Ongeldige crumb: "${crumb}"`);
  }

  return { crumb, cookie: cookieStr };
}

// ─── Haal auth op (uit cache of vers) ────────────────────────────────────────
async function getAuth(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await loadAuth();
    if (cached?.crumb && cached?.cookie) {
      return cached;
    }
  }

  const auth = await fetchFreshAuth();
  await saveAuth(auth.crumb, auth.cookie);
  return auth;
}

// ─── Proxy handler ────────────────────────────────────────────────────────────
async function handleProxy(url) {
  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) return jsonResponse({ error: 'Ontbrekende parameter: endpoint' }, 400);

  const isV10 = endpoint.startsWith('v10/') || endpoint.startsWith('v11/');
  const host  = isV10 ? 'query2.finance.yahoo.com' : 'query1.finance.yahoo.com';

  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (k !== 'endpoint') params.set(k, v);
  }

  let cookie = '';
  if (isV10) {
    try {
      const auth = await getAuth();
      if (auth.crumb) params.set('crumb', auth.crumb);
      cookie = auth.cookie;
    } catch (e) {
      console.error('Auth fout:', e.message);
    }
  }

  const doRequest = async (ck) => {
    const qs = params.size ? '?' + params.toString() : '';
    const hdrs = {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com/',
      'Origin': 'https://finance.yahoo.com',
    };
    if (ck) hdrs['Cookie'] = ck;
    return fetch(`https://${host}/${endpoint}${qs}`, {
      headers: hdrs,
      cf: { cacheTtl: isV10 ? 3600 : 300, cacheEverything: !isV10 }
    });
  };

  try {
    let res = await doRequest(cookie);

    // 401 → ververs crumb en retry
    if (res.status === 401 && isV10) {
      try {
        const auth2 = await getAuth(true); // force refresh
        params.set('crumb', auth2.crumb);
        res = await doRequest(auth2.cookie);
      } catch (e) {
        console.error('Retry auth fout:', e.message);
      }
    }

    if (!res.ok) return jsonResponse({ error: `Yahoo Finance ${res.status}` }, res.status);

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${isV10 ? 3600 : 300}`,
        ...corsHeaders()
      }
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
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
