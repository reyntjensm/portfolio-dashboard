// ═══════════════════════════════════════════════════════════════════════════════
// src/worker.js — Cloudflare Worker
// Serveert dashboard + Yahoo Finance proxy
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // /yf → Yahoo Finance proxy
    if (url.pathname.startsWith('/yf')) {
      return handleProxy(url);
    }

    // Alles anders → statische assets (index.html, src/data.js, ...)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Portfolio Worker OK', { headers: corsHeaders() });
  }
};

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
  const qs = params.size ? '?' + params.toString() : '';

  // v10 en v11 → query2, alle andere → query1
  const host = endpoint.startsWith('v10/') || endpoint.startsWith('v11/')
    ? 'query2.finance.yahoo.com'
    : 'query1.finance.yahoo.com';

  const yfUrl = `https://${host}/${endpoint}${qs}`;

  try {
    const res = await fetch(yfUrl, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         'https://finance.yahoo.com/',
        'Origin':          'https://finance.yahoo.com',
      },
      cf: { cacheTtl: 300, cacheEverything: true }
    });

    if (!res.ok) {
      return jsonResponse({ error: `Yahoo Finance ${res.status}` }, res.status);
    }

    const data = await res.json();
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, max-age=300',
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
