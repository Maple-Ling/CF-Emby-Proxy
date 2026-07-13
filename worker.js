import { Hono } from 'hono'

const CONFIG = {
  // [修改] 如果 KV 中找不到对应的域名，则回退到这个默认地址（可以写你的主服）
  DEFAULT_UPSTREAM: 'https://your-emby-server.com',
  
  STATIC_REGEX: /(\.(jpg|jpeg|png|gif|css|js|ico|svg|webp|woff|woff2)|(\/Images\/(Primary|Backdrop|Logo|Thumb|Banner|Art)))/i,
  VIDEO_REGEX: /(\/Videos\/|\/Items\/.*\/Download|\/Items\/.*\/Stream)/i,
  API_CACHE_REGEX: /(\/Items\/Resume|\/Users\/.*\/Items\/)/i,
  API_TIMEOUT: 2500
}

const app = new Hono()

async function fetchWithTimeout(url, options, timeout) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

app.all('*', async (c) => {
  const req = c.req.raw
  const url = new URL(req.url)
  const host = url.hostname // 获取当前访问的子域名，例如 nayovo.maple521.ggff.net

  // --- [核心升级：动态从 KV 读取对应 Emby 地址] ---
  let upstreamBase = CONFIG.DEFAULT_UPSTREAM;
  try {
    // 环境变量 EMBY_KV 需要在 Cloudflare Worker 设置中绑定
    if (c.env && c.env.EMBY_KV) {
      const kvValue = await c.env.EMBY_KV.get(host);
      if (kvValue) {
        upstreamBase = kvValue;
      }
    }
  } catch (e) {
    // KV 读取失败时回退到默认
  }

  // 强制使用动态获取的目标地址回源
  const targetUrl = new URL(url.pathname + url.search, upstreamBase)
  
  const proxyHeaders = new Headers(req.headers)
  proxyHeaders.set('Host', targetUrl.hostname)
  proxyHeaders.set('Referer', targetUrl.origin)
  proxyHeaders.set('Origin', targetUrl.origin)
  
  proxyHeaders.delete('cf-connecting-ip')
  proxyHeaders.delete('x-forwarded-for')
  proxyHeaders.delete('cf-ray')
  proxyHeaders.delete('cf-visitor')

  let reqBody = req.body
  if (!['GET', 'HEAD'].includes(req.method) && !url.pathname.includes('/Upload')) {
    reqBody = await req.arrayBuffer()
    proxyHeaders.delete('content-length')
  }

  const isStatic = CONFIG.STATIC_REGEX.test(url.pathname)
  const isVideo = CONFIG.VIDEO_REGEX.test(url.pathname)
  const isApiCacheable = CONFIG.API_CACHE_REGEX.test(url.pathname)
  const isWebSocket = req.headers.get('Upgrade') === 'websocket'

  const cfConfig = {
    cacheEverything: isStatic,
    cacheTtl: isStatic ? 31536000 : 0,
    cacheTtlByStatus: isApiCacheable ? { "200-299": 10 } : null,
    polish: isStatic ? 'lossy' : 'off',
    minify: { javascript: isStatic, css: isStatic, html: isStatic },
    mirage: false,
    scrapeShield: false,
    apps: false,
  }

  if (isApiCacheable) {
    cfConfig.cacheEverything = true
  }

  const fetchOptions = {
    method: req.method,
    headers: proxyHeaders,
    body: reqBody,
    redirect: 'manual',
    cf: cfConfig
  }

  try {
    let response;
    if (isVideo || isWebSocket || req.method === 'POST') {
      response = await fetch(targetUrl.toString(), fetchOptions)
    } else {
      try {
        response = await fetchWithTimeout(targetUrl.toString(), fetchOptions, CONFIG.API_TIMEOUT)
      } catch (err) {
        response = await fetch(targetUrl.toString(), fetchOptions)
      }
    }

    const resHeaders = new Headers(response.headers)
    resHeaders.delete('content-security-policy')
    resHeaders.delete('clear-site-data')
    resHeaders.set('access-control-allow-origin', '*')

    if (isVideo) {
        resHeaders.set('Connection', 'close')
    }
    
    if (isStatic && response.status === 200) {
        resHeaders.set('Cache-Control', 'public, max-age=31536000, immutable')
        resHeaders.delete('Pragma')
        resHeaders.delete('Expires')
    }

    if (response.status === 101) {
      return new Response(null, { status: 101, webSocket: response.webSocket, headers: resHeaders })
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = resHeaders.get('location')
        if (location) {
             const locUrl = new URL(location, targetUrl.href)
             if (locUrl.hostname === targetUrl.hostname) {
                 resHeaders.set('Location', locUrl.pathname + locUrl.search)
             }
        }
        return new Response(null, { status: response.status, headers: resHeaders })
    }

    return new Response(response.body, {
      status: response.status,
      headers: resHeaders
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: `Proxy Error: ${error.message}` }), { status: 502 })
  }
})

export default app
