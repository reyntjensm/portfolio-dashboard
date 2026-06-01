// ═══════════════════════════════════════════════════════════════════════════════
// src/worker.js — Cloudflare Worker
// Serveert dashboard + Yahoo Finance proxy met werkende cookie/crumb auth
// ═══════════════════════════════════════════════════════════════════════════════

// Cache crumb en cookie in Worker memory (blijft per Worker instantie)
let _crumb   = null;
let _cookie  = null;
let _crumbTs = 0;
const CRUMB_TTL = 60 * 60 * 1000; // 1 uur

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

// ─── Cookie + Crumb ophalen ───────────────────────────────────────────────────
async function getCrumb() {
  // Hergebruik als nog geldig
  if (_crumb && _cookie && Date.now() - _crumbTs < CRUMB_TTL) {
    return { crumb: _crumb, cookie: _cookie };
  }

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  // Stap 1: bezoek Yahoo Finance homepage om initiële cookies te krijgen
  const homeRes = await fetch('https://finance.yahoo.com/', {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  // Verzamel alle cookies
  const setCookies = homeRes.headers.getAll ? homeRes.headers.getAll('set-cookie') : [];
  let cookieStr = setCookies
    .map(c => c.split(';')[0])
    .filter(c => c.includes('='))
    .join('; ');

  // Stap 2: haal crumb op
  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': cookieStr,
      'Referer': 'https://finance.yahoo.com/',
      'Origin': 'https://finance.yahoo.com',
    },
  });

  if (crumbRes.ok) {
    const crumb = (await crumbRes.text()).trim();
    if (crumb && crumb.length > 0 && !crumb.includes('<') && crumb !== 'null') {
      _crumb   = crumb;
      _cookie  = cookieStr;
      _crumbTs = Date.now();
      return { crumb, cookie: cookieStr };
    }
  }

  // Stap 3: fallback — probeer via consent endpoint
  const consentRes = await fetch('https://guce.yahoo.com/consent?brandType=nonEu&lang=en-US&done=https%3A%2F%2Ffinance.yahoo.com%2F', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    redirect: 'follow',
  });
  const consentCookies = (consentRes.headers.getAll ? consentRes.headers.getAll('set-cookie') : [])
    .map(c => c.split(';')[0])
    .filter(c => c.includes('='))
    .join('; ');

  const allCookies = [cookieStr, consentCookies].filter(Boolean).join('; ');

  const crumbRes2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
      'Cookie': allCookies,
      'Referer': 'https://finance.yahoo.com/',
    },
  });

  if (crumbRes2.ok) {
    const crumb2 = (await crumbRes2.text()).trim();
    if (crumb2 && crumb2.length > 0 && !crumb2.includes('<') && crumb2 !== 'null') {
      _crumb   = crumb2;
      _cookie  = allCookies;
      _crumbTs = Date.now();
      return { crumb: crumb2, cookie: allCookies };
    }
  }

  return { crumb: null, cookie: allCookies };
}

// ─── Proxy handler ────────────────────────────────────────────────────────────
async function handleProxy(url) {
  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) {
    return jsonResponse({ error: 'Ontbrekende parameter: endpoint' }, 400);
  }

  const isV10 = endpoint.startsWith('v10/') || endpoint.startsWith('v11/');
  const host  = isV10 ? 'query2.finance.yahoo.com' : 'query1.finance.yahoo.com';

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  // Bouw query params op
  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (k !== 'endpoint') params.set(k, v);
  }

  // Voor v10: voeg crumb toe
  let cookie = '';
  if (isV10) {
    try {
      const auth = await getCrumb();
      if (auth.crumb) params.set('crumb', auth.crumb);
      cookie = auth.cookie || '';
    } catch (e) {
      console.error('Crumb fout:', e.message);
    }
  }

  const qs    = params.size ? '?' + params.toString() : '';
  const yfUrl = `https://${host}/${endpoint}${qs}`;

  const headers = {
    'User-Agent':      UA,
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer':         'https://finance.yahoo.com/',
    'Origin':          'https://finance.yahoo.com',
  };
  if (cookie) headers['Cookie'] = cookie;

  try {
    let res = await fetch(yfUrl, {
      headers,
      cf: { cacheTtl: isV10 ? 3600 : 300, cacheEverything: !isV10 }
    });

    // Bij 401: reset crumb en retry
    if (res.status === 401 && isV10) {
      _crumb = null; _cookie = null; _crumbTs = 0;
      try {
        const auth2 = await getCrumb();
        const p2 = new URLSearchParams(params);
        if (auth2.crumb) p2.set('crumb', auth2.crumb);
        const headers2 = { ...headers };
        if (auth2.cookie) headers2['Cookie'] = auth2.cookie;
        res = await fetch(`https://${host}/${endpoint}?${p2.toString()}`, { headers: headers2 });
      } catch (e) { /* val door naar originele response */ }
    }

    if (!res.ok) {
      return jsonResponse({ error: `Yahoo Finance ${res.status}` }, res.status);
    }

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type':  'application/json',
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
