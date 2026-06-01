// ═══════════════════════════════════════════════════════════════════════════════
// src/worker.js — Cloudflare Worker
// Serveert dashboard + Yahoo Finance proxy met crumb authenticatie
// ═══════════════════════════════════════════════════════════════════════════════

// Crumb cache — Yahoo Finance vereist een cookie+crumb voor v10 endpoints
let yfCrumb   = null;
let yfCookies = null;

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

// ─── Haal Yahoo Finance crumb + cookie op ─────────────────────────────────────
async function getYFCrumb() {
  if (yfCrumb && yfCookies) return { crumb: yfCrumb, cookies: yfCookies };

  // Stap 1: haal cookies op via consent pagina
  const consentRes = await fetch('https://fc.yahoo.com', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  const cookies = consentRes.headers.get('set-cookie') || '';

  // Stap 2: haal crumb op
  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Cookie': cookies,
      'Referer': 'https://finance.yahoo.com/',
    },
  });

  if (crumbRes.ok) {
    const crumb = await crumbRes.text();
    if (crumb && crumb !== 'null' && !crumb.includes('<')) {
      yfCrumb   = crumb.trim();
      yfCookies = cookies;
      return { crumb: yfCrumb, cookies: yfCookies };
    }
  }

  return { crumb: null, cookies };
}

async function handleProxy(url) {
  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) {
    return jsonResponse({ error: 'Ontbrekende parameter: endpoint' }, 400);
  }

  // Bouw extra query params op (alles behalve 'endpoint')
  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (k !== 'endpoint') params.set(k, v);
  }

  const isV10 = endpoint.startsWith('v10/') || endpoint.startsWith('v11/');
  const host  = isV10 ? 'query2.finance.yahoo.com' : 'query1.finance.yahoo.com';

  // Voor v10 endpoints: voeg crumb toe
  let cookies = '';
  if (isV10) {
    try {
      const auth = await getYFCrumb();
      if (auth.crumb) params.set('crumb', auth.crumb);
      cookies = auth.cookies || '';
    } catch (e) {
      console.error('Crumb ophalen mislukt:', e.message);
    }
  }

  const qs     = params.size ? '?' + params.toString() : '';
  const yfUrl  = `https://${host}/${endpoint}${qs}`;

  try {
    const headers = {
      'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept':          'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer':         'https://finance.yahoo.com/',
      'Origin':          'https://finance.yahoo.com',
    };
    if (cookies) headers['Cookie'] = cookies;

    const res = await fetch(yfUrl, {
      headers,
      cf: { cacheTtl: isV10 ? 3600 : 300, cacheEverything: true }
    });

    // Bij 401: reset crumb en probeer opnieuw
    if (res.status === 401 && isV10) {
      yfCrumb = null;
      yfCookies = null;
      try {
        const auth2 = await getYFCrumb();
        const params2 = new URLSearchParams(params);
        if (auth2.crumb) params2.set('crumb', auth2.crumb);
        const qs2 = params2.size ? '?' + params2.toString() : '';
        const res2 = await fetch(`https://${host}/${endpoint}${qs2}`, {
          headers: { ...headers, 'Cookie': auth2.cookies || '' },
        });
        if (res2.ok) {
          const data2 = await res2.json();
          return new Response(JSON.stringify(data2), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', ...corsHeaders() }
          });
        }
      } catch (e2) { /* geef originele fout terug */ }
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
