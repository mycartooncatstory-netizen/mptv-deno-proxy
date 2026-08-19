// ═══════════════════════════════════════════════════════════════════════
//  MPTV MSX Plugin — Full Deno Deploy Server
//  Vercel-independent: serves plugin HTML, hls.js, all Alloha/delivembd
//  APIs, m3u8/.ts segment proxy, and remote log collector.
// ═══════════════════════════════════════════════════════════════════════
//
//  Endpoints (all CORS-enabled):
//    GET  /msx/start.json            → MSX Start Object (points to /api/msx/launch)
//    GET  /api/msx/launch            → {action:"link:<self>/api/msx/plugin?v=<ts>"}
//    GET  /api/msx/plugin            → HTML plugin (fetched from GitHub raw, cached)
//    GET  /msx/plugin/hls.min.js     → hls.js library (fetched from GitHub raw, cached)
//    GET  /msx/plugin/index.html     → alias of /api/msx/plugin
//    GET  /api/mptv/genre            → Alloha genre list (filters: serial/anime/quality/voiceover)
//    GET  /api/mptv/resolve          → delivembd embed → master.m3u8 URL
//    GET  /api/mptv/search           → Alloha search
//    GET  /?url=<encoded>            → proxy for .ts/.m4s/.m3u8/.mp4/.key (rewrites m3u8 segments)
//    POST /api/debug/logs            → store logs (in-memory Map)
//    GET  /api/debug/logs            → return logs (?last=1 or ?device=ID)
//    GET  /health                    → liveness probe
// ═══════════════════════════════════════════════════════════════════════

// ─── Tokens & hosts ────────────────────────────────────────────────────
const SEARCH_TOKEN = 'eb79c8a500d725f071c3bcc1e975bb'
const GENRE_TOKEN  = 'b156e6d24abe787bc067a873c04975'

// Per task: only these two Alloha hosts are alive; the other 3 are dead.
const ALLOHA_HOSTS = [
  'https://api.apbugall.org',
  'https://api.alloha.tv',
]

// Resolve hosts — delivembd primary, alloha.tv fallback (embed mirror).
const EMBED_HOSTS = [
  'https://api.delivembd.ws/embed/kp',
  'https://api.alloha.tv/embed/kp',
]

// Plugin HTML + hls.js fetched from GitHub raw (cached in memory).
const GITHUB_HTML_URL  = 'https://raw.githubusercontent.com/mycartooncatstory-netizen/MPTVMSX-web/main/public/msx/plugin/index.html'
const GITHUB_HLSJS_URL = 'https://raw.githubusercontent.com/mycartooncatstory-netizen/MPTVMSX-web/main/public/msx/plugin/hls.min.js'

// User-Agent for outbound CDN requests. Short form per task spec; verified
// to work for both delivembd embed fetch and segment proxy.
const CDN_UA      = 'Mozilla/5.0 Chrome/120'
const CDN_REFERER = 'https://api.delivembd.ws/'

// ─── CORS ───────────────────────────────────────────────────────────────
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
}

function cors(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const headers = new Headers(CORS_HEADERS)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  if (init.headers) {
    for (const [k, v] of Object.entries(init.headers)) headers.set(k, v)
  }
  return new Response(JSON.stringify(body), { status: init.status || 200, headers })
}

function text(body: string, contentType = 'text/plain; charset=utf-8', status = 200): Response {
  const headers = new Headers(CORS_HEADERS)
  headers.set('Content-Type', contentType)
  return new Response(body, { status, headers })
}

// ─── Self-reference base URL ────────────────────────────────────────────
// Prefer DENO_DEPLOY_URL env (set in Deno Deploy dashboard); otherwise
// derive from request origin. Strips trailing slash.
function getBaseUrl(req: Request): string {
  const env = Deno.env.get('DENO_DEPLOY_URL')
  if (env && env.trim()) return env.trim().replace(/\/+$/, '')
  return new URL(req.url).origin
}

// ─── In-memory caches ───────────────────────────────────────────────────
let pluginHtmlCache: string | null = null
let pluginHtmlPromise: Promise<string> | null = null

let hlsJsCache: string | null = null
let hlsJsPromise: Promise<string> | null = null

async function fetchPluginHtml(): Promise<string> {
  if (pluginHtmlCache !== null) return pluginHtmlCache
  if (pluginHtmlPromise) return pluginHtmlPromise
  pluginHtmlPromise = (async () => {
    const r = await fetch(GITHUB_HTML_URL, {
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': CDN_UA, Accept: 'text/html,*/*' },
    })
    if (!r.ok) throw new Error('github html http=' + r.status)
    const t = await r.text()
    pluginHtmlCache = t
    return t
  })()
  try {
    return await pluginHtmlPromise
  } finally {
    pluginHtmlPromise = null
  }
}

async function fetchHlsJs(): Promise<string> {
  if (hlsJsCache !== null) return hlsJsCache
  if (hlsJsPromise) return hlsJsPromise
  hlsJsPromise = (async () => {
    const r = await fetch(GITHUB_HLSJS_URL, {
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': CDN_UA, Accept: '*/*' },
    })
    if (!r.ok) throw new Error('github hls.js http=' + r.status)
    const t = await r.text()
    hlsJsCache = t
    return t
  })()
  try {
    return await hlsJsPromise
  } finally {
    hlsJsPromise = null
  }
}

// ─── Remote log store (in-memory Map) ───────────────────────────────────
interface DeviceLogs {
  deviceId: string
  ua: string
  url: string
  firstSeen: number
  lastSeen: number
  logs: string[]
}
const LOGS_STORE = new Map<string, DeviceLogs>()

// ─── Alloha types & filters (ported from src/app/api/mptv/genre/route.ts) ─
interface AllohaTranslation {
  name?: string
  quality?: string
  adv?: boolean
  iframe?: string
}
interface TranslationWithId {
  id: string
  name: string
  quality: string
  adv: boolean
  iframe?: string
}
interface AllohaMovie {
  name: string
  original_name?: string | null
  year: number
  id_kp: number
  id_imdb?: string
  time?: string
  poster?: string
  description?: string
  genre?: string
  category?: string
  category_id?: number
  seasons_count?: number | null
  seasons?: Record<string, unknown> | null
  translation?: string
  translation_iframe?: string | Record<string, AllohaTranslation>
  iframe?: string
  quality?: string
  last_season?: number | null
  last_episode?: number | null
}

const BAD_KEYWORDS = [
  '1xbet', 'joycasino', 'azino', 'bet', 'букмекер', 'казино',
  'реклама', 'line', 'camrip', 'любительский', 'хихикающий',
  'ts', 'субтитры', 'sub', 'eng', 'оригинал',
]
const CLEAN_VOICEOVERS = [
  'дубляж', 'профессиональный', 'лостфильм', 'lostfilm', 'hdrezka',
  'red head sound', 'rhs', 'кубик в кубе', 'tvshows', 'тв3', 'стс',
  'многоголосый', 'gavrilov',
]
const QUALITY_RANK: Record<string, number> = {
  'bluray': 100, 'blu-ray': 100, 'bdremux': 95,
  'web-dl 1080p': 90, 'web-dl 1080': 90, 'webdl 1080p': 90,
  'bdrip 1080p': 85, 'bdrip 720p': 80,
  'webrip 1080p': 75, 'webrip 720p': 70, 'web-dl 720p': 70,
  'dvdrip': 50, 'ts': 20, 'camrip': 10, 'cam': 10,
}
const DIRTY_PATTERNS = [/1xbet/i, /joycasino/i, /camrip/i, /реклама/i, /казино/i, /ставки/i]

function qualityRank(quality: string): number {
  const q = (quality || '').toLowerCase()
  if (q.includes('4k') || q.includes('2160')) return 30
  let best = 0
  for (const [key, val] of Object.entries(QUALITY_RANK)) {
    if (q.includes(key) && val > best) best = val
  }
  return best || 40
}

// Strict quality gate: accept 720p/1080p/BluRay/WEB-DL only; reject TS/CAMRip/4K/unknown.
function isAcceptableQuality(quality: string): boolean {
  const q = (quality || '').toLowerCase()
  if (!q) return false
  // Reject bad qualities explicitly.
  if (q.includes('camrip') || q.includes('cam-')) return false
  // 4K too heavy for old devices.
  if (q.includes('4k') || q.includes('2160')) return false
  // TS / telecine (only when 'ts' appears as a standalone token).
  if (/(^|[^a-z0-9])ts([^a-z0-9]|$)/i.test(q)) return false
  // Accept explicit 720p+ markers.
  return q.includes('720') || q.includes('1080') ||
    q.includes('bluray') || q.includes('blu-ray') ||
    q.includes('bdremux') || q.includes('bdrip') ||
    q.includes('web-dl') || q.includes('webdl') || q.includes('webrip')
}

function isCleanTranslation(translation: string, adv: boolean): boolean {
  if (adv) return false
  const t = (translation || '').toLowerCase()
  for (const bad of BAD_KEYWORDS) {
    if (t.includes(bad)) return false
  }
  for (const clean of CLEAN_VOICEOVERS) {
    if (t.includes(clean)) return true
  }
  return false
}

function isAcceptableTranslation(translation: string, adv: boolean): boolean {
  if (adv) return false
  const t = (translation || '').toLowerCase()
  for (const bad of BAD_KEYWORDS) {
    if (t.includes(bad)) return false
  }
  return true
}

function parseDuration(time?: string): number {
  if (!time) return 0
  const m = time.match(/(\d+):(\d+)/)
  if (!m) return 0
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}

// Pick best (clean, highest-quality) translation WITH its ID so resolve chain
// can request SPECIFIC translation from delivembd.
function pickBestTranslation(
  translationIframeRaw: string | Record<string, AllohaTranslation> | undefined,
  fallbackTranslation: string | undefined,
  fallbackQuality: string | undefined
): { id: string; translation: string; quality: string; qualityScore: number; isClean: boolean } | null {
  let translationsWithIds: TranslationWithId[] = []
  if (translationIframeRaw) {
    let parsedObj: Record<string, AllohaTranslation> | null = null
    if (typeof translationIframeRaw === 'string') {
      try {
        const parsed = JSON.parse(translationIframeRaw)
        if (Array.isArray(parsed)) {
          parsed.forEach((t, i) => {
            translationsWithIds.push({
              id: String(i),
              name: t.name || '',
              quality: t.quality || '',
              adv: t.adv || false,
              iframe: t.iframe,
            })
          })
        } else if (typeof parsed === 'object' && parsed) {
          parsedObj = parsed
        }
      } catch { /* not JSON — fall through */ }
    } else if (typeof translationIframeRaw === 'object') {
      parsedObj = translationIframeRaw as Record<string, AllohaTranslation>
    }
    if (parsedObj) {
      for (const [tid, t] of Object.entries(parsedObj)) {
        translationsWithIds.push({
          id: tid,
          name: t.name || '',
          quality: t.quality || '',
          adv: t.adv || false,
          iframe: t.iframe,
        })
      }
    }
  }
  if (!translationsWithIds.length && fallbackTranslation) {
    translationsWithIds = [{
      id: '',
      name: fallbackTranslation,
      quality: fallbackQuality || '',
      adv: false,
    }]
  }
  if (!translationsWithIds.length) return null

  const rankTrans = (t: TranslationWithId, isStrictClean: boolean) => {
    let score = qualityRank(t.quality)
    if (isStrictClean) score += 1000
    return score
  }

  // PASS 1: STRICT — explicit clean studio + adv=false + no bad keywords.
  const strictClean = translationsWithIds
    .filter((t) => isCleanTranslation(t.name, t.adv))
    .map((t) => ({ ...t, score: rankTrans(t, true) }))
    .sort((a, b) => b.score - a.score)
  if (strictClean.length > 0) {
    const best = strictClean[0]
    return { id: best.id, translation: best.name, quality: best.quality, qualityScore: best.score, isClean: true }
  }

  // PASS 2: LOOSE — adv=false + no bad keywords (generic voiceovers).
  const looseAcceptable = translationsWithIds
    .filter((t) => isAcceptableTranslation(t.name, t.adv))
    .map((t) => ({ ...t, score: rankTrans(t, false) }))
    .sort((a, b) => b.score - a.score)
  if (looseAcceptable.length > 0) {
    const best = looseAcceptable[0]
    return { id: best.id, translation: best.name, quality: best.quality, qualityScore: best.score, isClean: false }
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── Endpoint: GET /msx/start.json ──────────────────────────────────────
// MSX Start Object — points MSX at /api/msx/launch on THIS server.
async function handleStart(req: Request): Promise<Response> {
  const baseUrl = getBaseUrl(req)
  const startObject = {
    name: 'MyPersonalTV',
    version: '1.0.0',
    parameter: 'content:' + baseUrl + '/api/msx/launch?t=' + Date.now(),
    welcome: 'none',
    launcher: { type: 'default', icon: 'tv', color: '#1f2937' },
  }
  return json(startObject, {
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Vary: 'User-Agent',
    },
  })
}

// ─── Endpoint: GET /api/msx/launch ──────────────────────────────────────
async function handleLaunch(req: Request): Promise<Response> {
  const baseUrl = getBaseUrl(req)
  const ts = Date.now()
  return json(
    { action: 'link:' + baseUrl + '/api/msx/plugin?v=' + ts },
    { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } }
  )
}

// ─── Endpoint: GET /api/msx/plugin (alias: /msx/plugin/index.html) ─────
async function handlePlugin(): Promise<Response> {
  let html: string
  try {
    html = await fetchPluginHtml()
  } catch (e) {
    const msg = (e as Error).message || String(e)
    return text(
      '<!DOCTYPE html><html><body><h2>Plugin load failed</h2><pre>' + msg + '</pre>' +
      '<p>GitHub raw URL: ' + GITHUB_HTML_URL + '</p></body></html>',
      'text/html; charset=utf-8', 502
    )
  }
  return new Response(html, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  })
}

// ─── Endpoint: GET /msx/plugin/hls.min.js ───────────────────────────────
async function handleHls(): Promise<Response> {
  let js: string
  try {
    js = await fetchHlsJs()
  } catch (e) {
    const msg = (e as Error).message || String(e)
    return text('// hls.js load failed: ' + msg + '\n// ' + GITHUB_HLSJS_URL,
      'application/javascript; charset=utf-8', 502)
  }
  return new Response(js, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}

// ─── Endpoint: GET /api/mptv/genre ──────────────────────────────────────
async function handleGenre(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  const genre = searchParams.get('genre') || ''
  const page = parseInt(searchParams.get('page') || '1', 10)
  const filterSerials = searchParams.get('filterSerials') !== '0'
  const filterDirty = searchParams.get('filterDirty') !== '0'
  if (!genre.trim()) return json({ error: 'genre query param required' }, { status: 400 })

  const tried: string[] = []
  for (const host of ALLOHA_HOSTS) {
    const url = host + '/?token=' + GENRE_TOKEN + '&list=1&type=movie&genre=' + encodeURIComponent(genre) + '&page=' + page
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: 'application/json',
          'User-Agent': CDN_UA,
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
      })
      if (!r.ok) { tried.push(host + ':http=' + r.status); continue }
      const jsonBody = await r.json() as { status?: string; data?: AllohaMovie[] }
      if (jsonBody.status !== 'success' || !Array.isArray(jsonBody.data)) {
        tried.push(host + ':status=' + jsonBody.status)
        continue
      }

      const movies = []
      for (const m of jsonBody.data) {
        const kp = m.id_kp
        const name = m.name || m.original_name || 'Без названия'
        const lowerName = name.toLowerCase()

        // ─── Serial filter (multiple signals) ───
        const cat = (m.category || '').toLowerCase()
        const isSerial =
          cat === 'сериал' ||
          m.category_id === 2 ||
          (m.last_episode != null && m.last_episode > 0) ||
          (m.seasons_count != null && m.seasons_count >= 1) ||
          !!m.seasons ||
          /сезон|серия|выпуск|сериал|season|episode|s\d+e\d+|s\d{2}/i.test(lowerName)
        if (filterSerials && isSerial) continue

        // ─── Anime filter ───
        const genreStr = (m.genre || '').toLowerCase()
        const isAnime =
          cat === 'аниме' ||
          /аниме|anime/i.test(genreStr) ||
          /аниме|anime|\bova\b/i.test(lowerName)
        if (isAnime) continue

        // ─── Translation filter (STRICT clean studios + adv=false) ───
        const best = pickBestTranslation(m.translation_iframe, m.translation, m.quality)
        if (!best) continue
        if (filterDirty && DIRTY_PATTERNS.some((p) => p.test(best.translation))) continue

        // ─── Quality filter (720p+, no TS/CAMRip/4K) ───
        if (!isAcceptableQuality(best.quality)) continue

        movies.push({
          kp,
          name,
          year: m.year || 0,
          poster: m.poster || '',
          description: m.description || '',
          genre: m.genre || genre,
          translation: best.translation,
          quality: best.quality,
          qualityScore: best.qualityScore,
          durationMin: parseDuration(m.time),
          isSerial,
          isCleanVoiceover: best.isClean,
          allohaUrl: 'alloha://play?title=' + encodeURIComponent(name) + '&kp=' + kp + '&imdb=' + (m.id_imdb || '') + '&tr=' + best.id,
        })
      }

      movies.sort((a, b) => b.qualityScore - a.qualityScore)

      return json(
        { genre, page, count: movies.length, movies, source: host },
        { headers: { 'Cache-Control': 'public, max-age=600, stale-while-revalidate=1200' } }
      )
    } catch (e) {
      tried.push(host + ':error=' + (e as Error).message)
    }
    await sleep(250) // anti-ban delay between hosts
  }
  return json({ error: 'All Alloha hosts failed', genre, page, tried }, { status: 502 })
}

// ─── Endpoint: GET /api/mptv/resolve ─────────────────────────────────────
const M3U8_RE         = /https?:\/\/[a-z0-9.-]+\.interkh\.com\/[^"'\s]*?master\.m3u8[^"'\s]*/i
const GENERIC_M3U8_RE = /https?:\/\/[^"'\s]*?master\.m3u8[^"'\s]*/i

async function handleResolve(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  const kp = searchParams.get('kp')
  const tr = searchParams.get('tr')
  if (!kp || !/^\d+$/.test(kp)) {
    return json({ error: 'kp query param required (numeric kinopoisk id)' }, { status: 400 })
  }

  const tried: string[] = []
  for (const host of EMBED_HOSTS) {
    let embedUrl = host + '/' + kp
    if (tr) embedUrl += '?translation=' + encodeURIComponent(tr)
    try {
      const r = await fetch(embedUrl, {
        headers: {
          'User-Agent': CDN_UA,
          Referer: CDN_REFERER,
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(12000),
      })
      if (!r.ok) { tried.push(host + ':http=' + r.status); continue }
      const html = await r.text()
      const match = html.match(M3U8_RE) || html.match(GENERIC_M3U8_RE)
      if (match && match[0]) {
        return json(
          { url: match[0], source: host, kp },
          { headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=600' } }
        )
      }
      tried.push(host + ':no-m3u8-in-' + html.length + 'b')
    } catch (e) {
      tried.push(host + ':error=' + (e as Error).message)
    }
  }
  return json({ error: 'Could not resolve HLS stream', kp, tried }, { status: 404 })
}

// ─── Endpoint: GET /api/mptv/search ─────────────────────────────────────
async function handleSearch(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  const query = searchParams.get('q') || searchParams.get('name') || ''
  if (!query.trim()) return json({ error: 'q query param required' }, { status: 400 })

  const tried: string[] = []
  for (const host of ALLOHA_HOSTS) {
    const url = host + '/?token=' + SEARCH_TOKEN + '&list=1&type=movie&name=' + encodeURIComponent(query)
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json', 'User-Agent': CDN_UA },
      })
      if (!r.ok) { tried.push(host + ':http=' + r.status); continue }
      const jsonBody = await r.json() as { status?: string; data?: AllohaMovie[] }
      if (jsonBody.status !== 'success' || !Array.isArray(jsonBody.data)) {
        tried.push(host + ':status=' + jsonBody.status)
        continue
      }
      const items = jsonBody.data.map((m) => ({
        kp: m.id_kp,
        name: m.name || m.original_name || 'Без названия',
        originalName: m.original_name || '',
        year: m.year || 0,
        imdb: m.id_imdb || '',
        poster: m.poster || '',
        description: m.description || '',
        genre: m.genre || '',
        translation: m.translation || '',
        quality: m.quality || '',
        durationMin: parseDuration(m.time),
        isSerial: !!(m.last_season && m.last_season > 1),
        isCleanVoiceover: !(m.translation && DIRTY_PATTERNS.some((p) => p.test(m.translation!))),
        iframe: m.iframe || '',
      }))
      return json(
        { query, count: items.length, items, source: host },
        { headers: { 'Cache-Control': 'public, max-age=120, stale-while-revalidate=300' } }
      )
    } catch (e) {
      tried.push(host + ':error=' + (e as Error).message)
    }
  }
  return json({ error: 'All Alloha hosts failed', query, tried }, { status: 502 })
}

// ─── Endpoint: GET /?url=<encoded>  (m3u8/.ts/.m4s/.mp4/.key proxy) ─────
async function handleProxy(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const targetUrl = url.searchParams.get('url')

  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    // Status / help page when no ?url= provided.
    const baseUrl = getBaseUrl(req)
    const help = {
      ok: true,
      service: 'MPTV Deno Proxy',
      endpoints: {
        start: baseUrl + '/msx/start.json',
        launch: baseUrl + '/api/msx/launch',
        plugin: baseUrl + '/api/msx/plugin',
        hls: baseUrl + '/msx/plugin/hls.min.js',
        genre: baseUrl + '/api/mptv/genre?genre=<X>&page=<Y>',
        resolve: baseUrl + '/api/mptv/resolve?kp=<X>&tr=<Y>',
        search: baseUrl + '/api/mptv/search?q=<X>',
        proxy: baseUrl + '/?url=<encoded-media-url>',
        logsGet: baseUrl + '/api/debug/logs',
        logsPost: baseUrl + '/api/debug/logs (POST)',
      },
      cached: {
        pluginHtml: pluginHtmlCache !== null,
        hlsJs: hlsJsCache !== null,
      },
      logsStore: LOGS_STORE.size,
    }
    return json(help)
  }

  if (!/\.(ts|m4s|m3u8|mp4|key)(\?|$|#)/i.test(targetUrl)) {
    return text('Only media files (.ts, .m3u8, .m4s, .mp4, .key) allowed', 'text/plain', 403)
  }

  try {
    const response = await fetch(targetUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: {
        'User-Agent': CDN_UA,
        Referer: CDN_REFERER,
        Accept: '*/*',
      },
      signal: AbortSignal.timeout(30000),
    })

    const headers = new Headers(response.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    headers.set('Access-Control-Allow-Headers', '*')
    // Strip CORS-conflicting headers that the upstream might have set.
    headers.delete('Access-Control-Allow-Credentials')

    // .m3u8 → rewrite segment/key/map URIs to point back through this proxy.
    if (/\.m3u8(\?|$|#)/i.test(targetUrl)) {
      headers.set('Cache-Control', 'public, max-age=300')
      headers.set('Content-Type', 'application/vnd.apple.mpegurl')
      const body = await response.text()
      const baseUrlOfM3u8 = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1)
      const proxyBase = url.origin + '/?url='

      // Rewrite URI="..." inside #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA lines.
      let rewritten = body.replace(/URI="([^"]+)"/g, (_m, u: string) => {
        const abs = /^https?:\/\//i.test(u) ? u : baseUrlOfM3u8 + u
        return 'URI="' + proxyBase + encodeURIComponent(abs) + '"'
      })

      // Rewrite plain segment lines (non-comment).
      const lines = rewritten.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const abs = /^https?:\/\//i.test(trimmed) ? trimmed : baseUrlOfM3u8 + trimmed
        lines[i] = proxyBase + encodeURIComponent(abs)
      }
      rewritten = lines.join('\n')
      return new Response(rewritten, { status: response.status, headers })
    }

    // Binary segment → stream through.
    headers.set('Cache-Control', 'public, max-age=86400')
    return new Response(response.body, { status: response.status, headers })
  } catch (e) {
    const msg = (e as Error).message || String(e)
    return text('Proxy error: ' + msg, 'text/plain', 502)
  }
}

// ─── Endpoint: POST /api/debug/logs ──────────────────────────────────────
async function handleLogsPost(req: Request): Promise<Response> {
  try {
    const body = await req.json() as {
      deviceId?: string
      logs?: string[]
      ua?: string
      url?: string
      full?: boolean
    }
    const deviceId = body.deviceId || 'unknown'
    const logs = Array.isArray(body.logs) ? body.logs : []
    const ua = body.ua || req.headers.get('user-agent') || ''
    const urlField = body.url || ''
    const full = body.full === true

    let entry = LOGS_STORE.get(deviceId)
    if (!entry) {
      entry = {
        deviceId,
        ua, url: urlField,
        firstSeen: Date.now(), lastSeen: Date.now(),
        logs: [],
      }
      LOGS_STORE.set(deviceId, entry)
    }
    if (full) {
      entry.logs = logs.slice(-500)
    } else {
      const existingTail = entry.logs.slice(-10)
      for (const line of logs) {
        if (existingTail.indexOf(line) === -1) entry.logs.push(line)
      }
      if (entry.logs.length > 500) entry.logs = entry.logs.slice(-500)
    }
    entry.lastSeen = Date.now()
    entry.ua = ua
    entry.url = urlField

    return json({ ok: true, deviceId, logCount: entry.logs.length })
  } catch (e) {
    return json({ error: (e as Error).message }, { status: 500 })
  }
}

// ─── Endpoint: GET /api/debug/logs ───────────────────────────────────────
async function handleLogsGet(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url)
  const deviceFilter = searchParams.get('device')
  const lastOnly = searchParams.get('last') === '1'

  if (lastOnly) {
    let latest: DeviceLogs | null = null
    for (const v of LOGS_STORE.values()) {
      if (!latest || v.lastSeen > latest.lastSeen) latest = v
    }
    return json({
      device: latest ? {
        deviceId: latest.deviceId,
        ua: latest.ua,
        url: latest.url,
        firstSeen: new Date(latest.firstSeen).toISOString(),
        lastSeen: new Date(latest.lastSeen).toISOString(),
        logCount: latest.logs.length,
        logs: latest.logs,
      } : null,
    }, { headers: { 'Cache-Control': 'no-cache' } })
  }

  if (deviceFilter) {
    const entry = LOGS_STORE.get(deviceFilter)
    return json({
      device: entry ? {
        deviceId: entry.deviceId,
        ua: entry.ua,
        url: entry.url,
        firstSeen: new Date(entry.firstSeen).toISOString(),
        lastSeen: new Date(entry.lastSeen).toISOString(),
        logCount: entry.logs.length,
        logs: entry.logs,
      } : null,
    }, { headers: { 'Cache-Control': 'no-cache' } })
  }

  const devices = []
  for (const v of LOGS_STORE.values()) {
    devices.push({
      deviceId: v.deviceId,
      ua: v.ua,
      url: v.url,
      firstSeen: new Date(v.firstSeen).toISOString(),
      lastSeen: new Date(v.lastSeen).toISOString(),
      logCount: v.logs.length,
      lastLogs: v.logs.slice(-5),
    })
  }
  devices.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
  return json({
    totalDevices: devices.length,
    totalLogs: devices.reduce((s, v) => s + v.logCount, 0),
    devices,
  }, { headers: { 'Cache-Control': 'no-cache' } })
}

// ─── Router ─────────────────────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {
  const method = req.method
  const url = new URL(req.url)
  const path = url.pathname

  // CORS preflight for any route.
  if (method === 'OPTIONS') return cors()

  try {
    // ─── MSX lifecycle ───
    if (path === '/msx/start.json' && method === 'GET') return await handleStart(req)
    if (path === '/api/msx/launch' && method === 'GET') return await handleLaunch(req)
    if ((path === '/api/msx/plugin' || path === '/msx/plugin/index.html') && method === 'GET') {
      return await handlePlugin()
    }
    if (path === '/msx/plugin/hls.min.js' && method === 'GET') return await handleHls()

    // ─── MPTV API ───
    if (path === '/api/mptv/genre' && method === 'GET') return await handleGenre(req)
    if (path === '/api/mptv/resolve' && method === 'GET') return await handleResolve(req)
    if (path === '/api/mptv/search' && method === 'GET') return await handleSearch(req)

    // ─── Debug logs ───
    if (path === '/api/debug/logs') {
      if (method === 'POST') return await handleLogsPost(req)
      if (method === 'GET') return await handleLogsGet(req)
      return text('Method not allowed', 'text/plain', 405)
    }

    // ─── Health probe ───
    if ((path === '/health' || path === '/ping') && method === 'GET') {
      return json({
        ok: true,
        ts: Date.now(),
        cached: { pluginHtml: pluginHtmlCache !== null, hlsJs: hlsJsCache !== null },
        logsStore: LOGS_STORE.size,
      })
    }

    // ─── Media proxy: / (with ?url=) ───
    if (path === '/' || path === '') {
      if (method === 'GET' || method === 'HEAD') return await handleProxy(req)
    }

    // Unknown route.
    return text('Not found: ' + method + ' ' + path, 'text/plain', 404)
  } catch (e) {
    const msg = (e as Error).message || String(e)
    return json({ error: 'Internal', message: msg }, { status: 500 })
  }
})
