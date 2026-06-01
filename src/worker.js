// ═══════════════════════════════════════════════════════════════════════════════
// src/worker.js — Cloudflare Worker: Yahoo Finance CORS Proxy
// Deploy: kopieer deze code naar je Worker in dash.cloudflare.com
//         Workers & Pages → portfolio-dashboard → Edit Code → Deploy
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Route: /yf → Yahoo Finance proxy
    if (url.pathname.startsWith('/yf')) {
      return handleProxy(url);
    }

    // Alle andere routes
    return new Response('Portfolio Worker OK', {
      headers: { 'Content-Type': 'text/plain', ...corsHeaders() }
    });
  }
};

async function handleProxy(url) {
  // endpoint param bevat het volledige Yahoo Finance pad
  // bv: endpoint=v8/finance/chart/AAPL&interval=1d&range=1d
  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) {
    return jsonResponse({ error: 'Ontbrekende parameter: endpoint' }, 400);
  }

  // Bouw query params op — alles behalve 'endpoint' zelf
  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (k !== 'endpoint') params.set(k, v);
  }

  // v10 en v11 endpoints → query2, de rest → query1
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
