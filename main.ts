Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400'
      }
    });
  }

  const url = new URL(req.url);
  const targetUrl = url.searchParams.get('url');
  
  if (!targetUrl || !/^https?:\/\//.test(targetUrl)) {
    return new Response('MPTV Proxy is running. Use /proxy?url=...', {
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' }
    });
  }

  if (!/\.(ts|m4s|m3u8|mp4|key)(\?|$)/i.test(targetUrl)) {
    return new Response('Only media files (.ts, .m3u8, .m4s) allowed', { status: 403 });
  }

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 Chrome/120',
        'Referer': 'https://api.delivembd.ws/',
        'Accept': '*/*'
      }
    });

    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', '*');
    
    if (/\.m3u8/i.test(targetUrl)) {
      headers.set('Cache-Control', 'public, max-age=300');
    } else {
      headers.set('Cache-Control', 'public, max-age=86400');
    }

    return new Response(response.body, {
      status: response.status,
      headers
    });
  } catch (err) {
    return new Response('Proxy error: ' + err.message, {
      status: 502,
      headers: { 'Access-Control-Allow-Origin': '*' }
    });
  }
});
