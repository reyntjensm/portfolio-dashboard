// ─── Cloudflare Worker: Yahoo Finance CORS Proxy ─────────────────────────────
// Bestandspad in repo: src/worker.js
// Deploy (eenmalig vanuit terminal in je repo-map): wrangler deploy
// Proxy URL na deploy: https://portfolio-dashboard.reyntjensm.workers.dev/yf

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }

    if (!url.pathname.startsWith('/yf')) {
      return new Response('Portfolio Worker OK', { headers: cors() });
    }

    const endpoint = url.searchParams.get('endpoint');
    if (!endpoint) return json({ error: 'Ontbrekende parameter: endpoint' }, 400);

    const params = new URLSearchParams();
    for (const [k, v] of url.searchParams) {
      if (k !== 'endpoint') params.set(k, v);
    }

    const host = /^v1[01]\//.test(endpoint)
      ? 'query2.finance.yahoo.com'
      : 'query1.finance.yahoo.com';
    const yfUrl = `https://${host}/${endpoint}${params.size ? '?' + params : ''}`;

    try {
      const res = await fetch(yfUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://finance.yahoo.com/',
        },
        cf: { cacheTtl: 300, cacheEverything: true }
      });

      if (!res.ok) return json({ error: `Yahoo antwoordde ${res.status}` }, res.status);

      const data = await res.json();
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300',
          ...cors()
        }
      });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() }
  });
}
