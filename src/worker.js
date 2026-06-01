// ═══════════════════════════════════════════════════════════════════════════════
// src/worker.js — Cloudflare Worker
// Serveert de volledige dashboard applicatie + Yahoo Finance proxy
// Automatisch gedeployd vanuit GitHub via Cloudflare
// ═══════════════════════════════════════════════════════════════════════════════

// index.html en data.js worden ingeladen via Cloudflare Assets (Static Files).
// Zorg dat in je Cloudflare Worker instellingen "Assets" is geconfigureerd,
// of gebruik onderstaande aanpak waarbij de Worker de bestanden via fetch ophaalt.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Route: /yf → Yahoo Finance proxy
    if (url.pathname.startsWith('/yf')) {
      return handleProxy(url);
    }

    // Route: /src/data.js → serveer data.js
    if (url.pathname === '/src/data.js') {
      return serveAsset(env, 'src/data.js', 'application/javascript');
    }

    // Route: / of alles anders → serveer index.html
    return serveAsset(env, 'index.html', 'text/html;charset=UTF-8');
  }
};

// Serveert een statisch bestand via Cloudflare Assets binding
async function serveAsset(env, path, contentType) {
  // Cloudflare Workers Static Assets: env.ASSETS
  if (env.ASSETS) {
    const asset = await env.ASSETS.fetch(new Request(`https://assets/${path}`));
    if (asset.ok) {
      return new Response(asset.body, {
        headers: { 'Content-Type': contentType, 'Cache-Control': 'no-cache' }
      });
    }
  }
  return new Response('Bestand niet gevonden: ' + path, { status: 404 });
}

async function handleProxy(url) {
  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) {
    return jsonResponse({ error: 'Ontbrekende parameter: endpoint' }, 400);
  }

  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (k !== 'endpoint') params.set(k, v);
  }

  const host = /^v1[01]\//.test(endpoint)
    ? 'query2.finance.yahoo.com'
    : 'query1.finance.yahoo.com';

  const yfUrl = `https://${host}/${endpoint}${params.size ? '?' + params.toString() : ''}`;

  try {
    const res = await fetch(yfUrl, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept':          'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         'https://finance.yahoo.com/',
      },
      cf: { cacheTtl: 300, cacheEverything: true }
    });

    if (!res.ok) {
      return jsonResponse({ error: `Yahoo Finance antwoordde ${res.status}` }, res.status);
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
