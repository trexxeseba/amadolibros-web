const GOOGLE_COMMON_CRAWLERS_URL = 'https://developers.google.com/static/crawling/ipranges/common-crawlers.json';
const GOOGLE_RANGES_KV_KEY = 'seo:crawl-logs-3:google-common-crawlers:v1';
const FLAG_PREFIX = 'seo:crawl-logs-3:enabled:';
const FLAG_CACHE_MS = 60_000;
const RANGE_FRESH_MS = 24 * 60 * 60 * 1000;
const ISOLATE_RANGE_CACHE_MS = 60 * 60 * 1000;
const SAMPLE_RATE = 0.01;

export const USEFUL_CRAWL_RATIO_V1 = Object.freeze({
  version: 1,
  numerator: 'verified Googlebot requests with HTTP 200 whose pattern is one of: home, libro, libros, catalogo, static_page',
  denominator: 'all verified Googlebot requests classified as content pages; excludes asset, api, sitemap and robots',
});

const USEFUL_PATTERNS = new Set(['home', 'libro', 'libros', 'catalogo', 'static_page']);
const DENOMINATOR_EXCLUDED = new Set(['asset', 'api', 'sitemap', 'robots']);
const STATIC_USEFUL_PATHS = new Set([
  '/contacto',
  '/politicas',
  '/envios',
  '/devoluciones',
  '/terminos',
  '/privacidad',
  '/libros-maria-montessori-uruguay',
]);

let flagCache = new Map();
let rangeCache = null;
let schemaReadyPromise = null;

function appEnv(env) {
  return String(env?.APP_ENV || 'unknown').toLowerCase();
}

function flagKey(env) {
  return `${FLAG_PREFIX}${appEnv(env)}`;
}

function isBotLikeUa(ua) {
  return /(bot|crawler|spider|slurp|bingpreview|google-inspectiontool)/i.test(ua || '');
}

export function isGooglebotUa(ua) {
  return /Googlebot/i.test(ua || '');
}

function onlyAllowedPageParam(url) {
  const keys = [...url.searchParams.keys()];
  if (keys.length === 0) return true;
  return keys.every(key => key === 'page') && /^\d+$/.test(url.searchParams.get('page') || '');
}

function hasAnyQuery(url) {
  return [...url.searchParams.keys()].length > 0;
}

export function classifyCrawlRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (/^\/_astro\//.test(path) || /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf)$/i.test(path)) {
    return { pattern: 'asset', legacy: false, contentPage: false, usefulCandidate: false };
  }
  if (path === '/robots.txt') {
    return { pattern: 'robots', legacy: false, contentPage: false, usefulCandidate: false };
  }
  if (/^\/sitemap(?:[-./]|$)/.test(path) || path === '/sitemap.xml') {
    return { pattern: 'sitemap', legacy: false, contentPage: false, usefulCandidate: false };
  }
  if (/^\/api(?:\/|$)/.test(path)) {
    return { pattern: 'api', legacy: false, contentPage: false, usefulCandidate: false };
  }

  if (url.searchParams.has('book')) {
    return { pattern: 'legacy_book', legacy: true, contentPage: true, usefulCandidate: false };
  }
  if (url.searchParams.has('add-to-cart')) {
    return { pattern: 'legacy_add_to_cart', legacy: true, contentPage: true, usefulCandidate: false };
  }
  if (/^\/producto(?:\/|$)/.test(path)) {
    return { pattern: 'legacy_producto', legacy: true, contentPage: true, usefulCandidate: false };
  }
  if (/^\/categoria-producto(?:\/|$)/.test(path)) {
    return { pattern: 'legacy_categoria_producto', legacy: true, contentPage: true, usefulCandidate: false };
  }
  if (/^\/(?:page\/\d+|(?:tienda|shop)\/page\/\d+)$/.test(path)) {
    return { pattern: 'legacy_pagination', legacy: true, contentPage: true, usefulCandidate: false };
  }
  if (/^\/(?:shop|tienda|mas-vendidos|my-orders)$/.test(path)) {
    return { pattern: 'legacy_root', legacy: true, contentPage: true, usefulCandidate: false };
  }

  if (path === '/') {
    return { pattern: hasAnyQuery(url) ? 'home_param' : 'home', legacy: false, contentPage: true, usefulCandidate: !hasAnyQuery(url) };
  }
  if (/^\/libro\/MLU\d+\/[^/]+$/i.test(path) && !hasAnyQuery(url)) {
    return { pattern: 'libro', legacy: false, contentPage: true, usefulCandidate: true };
  }
  if (/^\/libro(?:\/|$)/i.test(path)) {
    return { pattern: 'libro_variant', legacy: false, contentPage: true, usefulCandidate: false };
  }
  if (/^\/libros\/[^/]+$/i.test(path) && onlyAllowedPageParam(url)) {
    return { pattern: 'libros', legacy: false, contentPage: true, usefulCandidate: true };
  }
  if (/^\/libros(?:\/|$)/i.test(path)) {
    return { pattern: 'libros_param', legacy: false, contentPage: true, usefulCandidate: false };
  }
  if (path === '/catalogo') {
    return { pattern: hasAnyQuery(url) ? 'catalogo_param' : 'catalogo', legacy: false, contentPage: true, usefulCandidate: !hasAnyQuery(url) };
  }
  if (STATIC_USEFUL_PATHS.has(path) && !hasAnyQuery(url)) {
    return { pattern: 'static_page', legacy: false, contentPage: true, usefulCandidate: true };
  }
  return { pattern: 'other', legacy: false, contentPage: true, usefulCandidate: false };
}

export function shouldCaptureCrawlRequest(request, classification, randomFn = Math.random) {
  const ua = request.headers.get('user-agent') || '';
  if (classification.pattern === 'asset') return false;
  if (classification.legacy) return true;
  if (isBotLikeUa(ua)) return true;
  return randomFn() < SAMPLE_RATE;
}

function ipv4ToBigInt(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8n) | BigInt(n);
  }
  return out;
}

function normalizeIpv6WithEmbeddedIpv4(value) {
  const input = String(value || '').toLowerCase();
  if (!input.includes('.')) return input;
  const lastColon = input.lastIndexOf(':');
  if (lastColon < 0) return input;
  const ipv4 = ipv4ToBigInt(input.slice(lastColon + 1));
  if (ipv4 == null) return input;
  const high = Number((ipv4 >> 16n) & 0xffffn).toString(16);
  const low = Number(ipv4 & 0xffffn).toString(16);
  return `${input.slice(0, lastColon)}:${high}:${low}`;
}

function ipv6ToBigInt(value) {
  const input = normalizeIpv6WithEmbeddedIpv4(value);
  if (!input || input.includes(':::')) return null;
  const split = input.split('::');
  if (split.length > 2) return null;
  const head = split[0] ? split[0].split(':').filter(Boolean) : [];
  const tail = split.length === 2 && split[1] ? split[1].split(':').filter(Boolean) : [];
  let fill = 0;
  if (split.length === 2) fill = 8 - head.length - tail.length;
  else if (head.length !== 8) return null;
  if (fill < 0) return null;
  const parts = [...head, ...Array(fill).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  let out = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    out = (out << 16n) | BigInt(parseInt(part, 16));
  }
  return out;
}

export function parseIp(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.includes(':')) {
    const number = ipv6ToBigInt(text);
    return number == null ? null : { family: 6, number, bits: 128 };
  }
  const number = ipv4ToBigInt(text);
  return number == null ? null : { family: 4, number, bits: 32 };
}

export function parseCidr(cidr) {
  const [address, prefixRaw] = String(cidr || '').split('/');
  const ip = parseIp(address);
  const prefix = Number(prefixRaw);
  if (!ip || !Number.isInteger(prefix) || prefix < 0 || prefix > ip.bits) return null;
  const shift = BigInt(ip.bits - prefix);
  const network = shift === 0n ? ip.number : (ip.number >> shift) << shift;
  return { family: ip.family, prefix, bits: ip.bits, network };
}

export function ipMatchesParsedRanges(ipText, ranges) {
  const ip = parseIp(ipText);
  if (!ip) return null;
  for (const range of ranges || []) {
    if (!range || range.family !== ip.family) continue;
    const shift = BigInt(ip.bits - range.prefix);
    if ((ip.number >> shift) === (range.network >> shift)) return true;
  }
  return false;
}

function parseGoogleRangesPayload(payload) {
  const ranges = [];
  for (const prefix of payload?.prefixes || []) {
    const cidr = prefix.ipv4Prefix || prefix.ipv6Prefix;
    const parsed = parseCidr(cidr);
    if (parsed) ranges.push(parsed);
  }
  return ranges;
}

async function getFlag(env, nowMs) {
  const key = flagKey(env);
  const cached = flagCache.get(key);
  if (cached && cached.expiresAt > nowMs) return cached.enabled;
  if (!env?.AMADO_KV || typeof env.AMADO_KV.get !== 'function') return false;
  const raw = await env.AMADO_KV.get(key);
  const enabled = String(raw || '').toLowerCase() === 'true';
  flagCache.set(key, { enabled, expiresAt: nowMs + FLAG_CACHE_MS });
  return enabled;
}

async function loadGoogleRanges(env, nowMs, fetchFn) {
  if (rangeCache && rangeCache.expiresAt > nowMs) return rangeCache.ranges;

  let stored = null;
  if (env?.AMADO_KV && typeof env.AMADO_KV.get === 'function') {
    try {
      const raw = await env.AMADO_KV.get(GOOGLE_RANGES_KV_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
  }

  const storedFetchedAt = Date.parse(stored?.fetchedAt || '');
  const storedFresh = Number.isFinite(storedFetchedAt) && (nowMs - storedFetchedAt) < RANGE_FRESH_MS;
  if (storedFresh && stored?.payload) {
    const ranges = parseGoogleRangesPayload(stored.payload);
    rangeCache = { ranges, expiresAt: nowMs + ISOLATE_RANGE_CACHE_MS };
    return ranges;
  }

  try {
    const response = await fetchFn(GOOGLE_COMMON_CRAWLERS_URL, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Google ranges HTTP ${response.status}`);
    const payload = await response.json();
    const ranges = parseGoogleRangesPayload(payload);
    if (!ranges.length) throw new Error('Google ranges payload vacío');
    if (env?.AMADO_KV && typeof env.AMADO_KV.put === 'function') {
      await env.AMADO_KV.put(GOOGLE_RANGES_KV_KEY, JSON.stringify({ fetchedAt: new Date(nowMs).toISOString(), payload }));
    }
    rangeCache = { ranges, expiresAt: nowMs + ISOLATE_RANGE_CACHE_MS };
    return ranges;
  } catch (error) {
    if (stored?.payload) {
      const ranges = parseGoogleRangesPayload(stored.payload);
      if (ranges.length) {
        rangeCache = { ranges, expiresAt: nowMs + 5 * 60 * 1000 };
        return ranges;
      }
    }
    console.warn('[SEO-CRAWL-LOGS-3] No se pudieron cargar rangos Google:', error?.message || error);
    return null;
  }
}

async function verifyGooglebot(request, env, nowMs, fetchFn) {
  const ua = request.headers.get('user-agent') || '';
  if (!isGooglebotUa(ua)) return -1;
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip) return -2;
  const ranges = await loadGoogleRanges(env, nowMs, fetchFn);
  if (!ranges) return -2;
  const match = ipMatchesParsedRanges(ip, ranges);
  return match == null ? -2 : (match ? 1 : 0);
}

async function ensureSchema(db) {
  if (!db || typeof db.prepare !== 'function') return false;
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await db.prepare(`CREATE TABLE IF NOT EXISTS crawl_stats (
        date TEXT NOT NULL,
        pattern TEXT NOT NULL,
        status INTEGER NOT NULL,
        verified INTEGER NOT NULL,
        ua_googlebot INTEGER NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        bytes_sum INTEGER NOT NULL DEFAULT 0,
        bytes_known_count INTEGER NOT NULL DEFAULT 0,
        duration_ms_sum REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (date, pattern, status, verified, ua_googlebot)
      )`).run();
      return true;
    })().catch(error => {
      schemaReadyPromise = null;
      throw error;
    });
  }
  return schemaReadyPromise;
}

function knownContentLength(response) {
  const raw = response.headers.get('content-length');
  if (!raw || !/^\d+$/.test(raw)) return { bytes: 0, known: 0 };
  const bytes = Number(raw);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? { bytes, known: 1 } : { bytes: 0, known: 0 };
}

export function isUsefulRatioNumerator({ classification, status, verified }) {
  return verified === 1 && status === 200 && classification.usefulCandidate && USEFUL_PATTERNS.has(classification.pattern);
}

export function isUsefulRatioDenominator({ classification, verified }) {
  return verified === 1 && classification.contentPage && !DENOMINATOR_EXCLUDED.has(classification.pattern);
}

export async function recordCrawlRequest({ request, response, env, durationMs = 0 }, deps = {}) {
  const nowFn = deps.nowFn || Date.now;
  const fetchFn = deps.fetchFn || fetch;
  const randomFn = deps.randomFn || Math.random;
  const nowMs = nowFn();

  if (!(await getFlag(env, nowMs))) return { recorded: false, reason: 'disabled' };
  if (!env?.ORDERS_DB) return { recorded: false, reason: 'db_unavailable' };

  const classification = classifyCrawlRequest(request);
  if (!shouldCaptureCrawlRequest(request, classification, randomFn)) {
    return { recorded: false, reason: 'not_sampled' };
  }

  const ua = request.headers.get('user-agent') || '';
  const uaGooglebot = isGooglebotUa(ua) ? 1 : 0;
  const verified = await verifyGooglebot(request, env, nowMs, fetchFn);
  const { bytes, known } = knownContentLength(response);
  const date = new Date(nowMs).toISOString().slice(0, 10);
  const safeDuration = Number.isFinite(Number(durationMs)) ? Math.max(0, Number(durationMs)) : 0;

  await ensureSchema(env.ORDERS_DB);
  await env.ORDERS_DB.prepare(`INSERT INTO crawl_stats
    (date, pattern, status, verified, ua_googlebot, request_count, bytes_sum, bytes_known_count, duration_ms_sum)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(date, pattern, status, verified, ua_googlebot)
    DO UPDATE SET
      request_count = request_count + 1,
      bytes_sum = bytes_sum + excluded.bytes_sum,
      bytes_known_count = bytes_known_count + excluded.bytes_known_count,
      duration_ms_sum = duration_ms_sum + excluded.duration_ms_sum`).bind(
        date,
        classification.pattern,
        response.status,
        verified,
        uaGooglebot,
        bytes,
        known,
        safeDuration,
      ).run();

  return {
    recorded: true,
    pattern: classification.pattern,
    verified,
    uaGooglebot,
    usefulNumerator: isUsefulRatioNumerator({ classification, status: response.status, verified }),
    usefulDenominator: isUsefulRatioDenominator({ classification, verified }),
  };
}

export function scheduleCrawlAnalytics(context, response, durationMs = 0) {
  if (!context || typeof context.waitUntil !== 'function') return;
  if (!context.request || !context.env) return;
  context.waitUntil(
    recordCrawlRequest({ request: context.request, response, env: context.env, durationMs })
      .catch(error => console.warn('[SEO-CRAWL-LOGS-3] logging falló:', error?.message || error)),
  );
}

export function resetCrawlAnalyticsCachesForTest() {
  flagCache = new Map();
  rangeCache = null;
  schemaReadyPromise = null;
}
