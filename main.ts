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
    return new Response('MPTV Proxy running. Use /?url=...', {
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
      headers.set('Content-Type', 'application/vnd.apple.mpegurl');
      
      // Rewrite m3u8: make relative segment URLs point back to this proxy
      var text = await response.text();
      var baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      var proxyBase = url.origin + '/?url=';
      var lines = text.split('\n');
      var rewritten = lines.map(function(line) {
        var trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        // Relative URL → absolute → proxy
        var abs = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
        return proxyBase + encodeURIComponent(abs);
      });
      return new Response(rewritten.join('\n'), {
        status: response.status,
        headers
      });
    } else {
      headers.set('Cache-Control', 'public, max-age=86400');
      return new Response(response.body, {
        status: response.status,
        headers
      });
    }
  } catch (err) {
    return new Response('Proxy error: ' + err.message, {
      status: 502,
      headers: { 'Access-Control-Allow-Origin': '*' }
    });
  }
});
