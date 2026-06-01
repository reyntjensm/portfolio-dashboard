// ═══════════════════════════════════════════════════════════════════════════════
// src/worker.js — Cloudflare Worker
// Yahoo Finance proxy met werkende crumb authenticatie
// ═══════════════════════════════════════════════════════════════════════════════

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Worker-level cache (geldig zolang deze Worker instantie leeft, ~30 sec tot enkele minuten)
let _auth = null;

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

// ─── Crumb + cookie ophalen ───────────────────────────────────────────────────
async function getAuth(forceRefresh = false) {
  if (!forceRefresh && _auth) return _auth;

  try {
    // Stap 1: bezoek finance.yahoo.com en lees cookies
    const r1 = await fetch('https://finance.yahoo.com', {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    // In Cloudflare Workers: set-cookie is één gecombineerde string
    const setCookie = r1.headers.get('set-cookie') || '';
    
    // Parse cookies: splits op patroon ", naam=" want dat is het scheidingsteken
    const cookieJar = {};
    const parts = setCookie.split(/(?<=;)\s*(?=[A-Za-z_][A-Za-z0-9_]*=)/);
    for (const part of parts) {
      const [nameVal] = part.split(';');
      const eqIdx = nameVal.indexOf('=');
      if (eqIdx > 0) {
        const name = nameVal.slice(0, eqIdx).trim();
        const val  = nameVal.slice(eqIdx + 1).trim();
        if (name) cookieJar[name] = val;
      }
    }
    
    // Fallback: lees ook cookies uit de response body URL (soms redirect)
    const cookieStr = Object.entries(cookieJar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ') || setCookie.split(';')[0];

    // Stap 2: haal crumb op
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': cookieStr,
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com',
      },
    });

    if (!r2.ok) throw new Error(`getcrumb ${r2.status}`);

    const crumb = (await r2.text()).trim();
    if (!crumb || crumb.includes('<') || crumb === 'null') {
      throw new Error('Ongeldige crumb ontvangen');
    }

    _auth = { crumb, cookie: cookieStr };
    return _auth;

  } catch (e) {
    console.error('Auth fout:', e.message);
    return { crumb: null, cookie: '' };
  }
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

  // v10: voeg crumb toe
  let cookie = '';
  if (isV10) {
    const auth = await getAuth();
    if (auth.crumb) params.set('crumb', auth.crumb);
    cookie = auth.cookie;
  }

  const doFetch = async (extraCookie) => {
    const qs  = params.size ? '?' + params.toString() : '';
    const hdrs = {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com/',
      'Origin': 'https://finance.yahoo.com',
    };
    if (extraCookie) hdrs['Cookie'] = extraCookie;

    return fetch(`https://${host}/${endpoint}${qs}`, {
      headers: hdrs,
      cf: { cacheTtl: isV10 ? 3600 : 300, cacheEverything: !isV10 }
    });
  };

  try {
    let res = await doFetch(cookie);

    // Bij 401: ververs auth en probeer opnieuw
    if (res.status === 401 && isV10) {
      _auth = null;
      const auth2 = await getAuth(true);
      if (auth2.crumb) params.set('crumb', auth2.crumb);
      res = await doFetch(auth2.cookie);
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
