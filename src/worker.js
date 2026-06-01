// ═══════════════════════════════════════════════════════════════════════════════
// src/worker.js — Cloudflare Worker
// Serveert dashboard + Yahoo Finance v8 proxy (geen auth nodig)
// Analyst data gaat rechtstreeks via Alpha Vantage vanuit de browser
// ═══════════════════════════════════════════════════════════════════════════════

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // /yf → Yahoo Finance v8 proxy
    if (url.pathname.startsWith('/yf')) {
      return handleYahoo(url);
    }

    // Statische assets (index.html, src/data.js, ...)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Portfolio Worker OK', { headers: corsHeaders() });
  }
};

async function handleYahoo(url) {
  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) return jsonResponse({ error: 'Ontbrekende parameter: endpoint' }, 400);

  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (k !== 'endpoint') params.set(k, v);
  }
  const qs    = params.size ? '?' + params.toString() : '';
  const yfUrl = `https://query1.finance.yahoo.com/${endpoint}${qs}`;

  try {
    const res = await fetch(yfUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com/',
      },
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
