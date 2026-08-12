#!/usr/bin/env node
/**
 * scripts/smoke-production.js
 *
 * Post-deploy smoke tests for amadolibros.com.
 * Uses only Node.js 22 native APIs — no external dependencies.
 *
 * Configuration via environment variables:
 *   SMOKE_BASE_URL          default: https://www.amadolibros.com
 *   SMOKE_MAX_ATTEMPTS      default: 6
 *   SMOKE_RETRY_DELAY_MS    default: 10000
 *   SMOKE_TIMEOUT_MS        default: 10000
 *   SMOKE_EXPECT_CHECKOUT   required: "enabled" | "disabled"
 *
 * SMOKE_EXPECT_CHECKOUT declara en qué estado debe estar el checkout de
 * Mercado Pago en Producción. El smoke analiza el HTML servido de /carrito/ y
 * falla si el estado desplegado no coincide. No tiene valor por defecto a
 * propósito (fail-closed): quien despliega debe declarar explícitamente qué
 * espera, para que una activación o un rollback nunca pasen inadvertidos.
 *
 * Este script solo hace GET. Nunca envía POST, nunca crea órdenes, nunca pide
 * un token de Turnstile y nunca llama a Mercado Pago. El análisis es sobre el
 * HTML servido — no ejecuta JavaScript ni simula clics.
 */

'use strict';

const fs = require('fs');

const BASE_URL       = process.env.SMOKE_BASE_URL       || 'https://www.amadolibros.com';
const MAX_ATTEMPTS   = parseInt(process.env.SMOKE_MAX_ATTEMPTS   || '6',     10);
const RETRY_DELAY_MS = parseInt(process.env.SMOKE_RETRY_DELAY_MS || '10000', 10);
const TIMEOUT_MS     = parseInt(process.env.SMOKE_TIMEOUT_MS     || '10000', 10);

const VALID_CHECKOUT_EXPECTATIONS = ['enabled', 'disabled'];

// Site keys públicas de Turnstile (no son secretos: viajan en el HTML).
const TURNSTILE_SITE_KEY_PRODUCTION = '0x4AAAAAAD_Ul8KGae_hdWwj';
const TURNSTILE_SITE_KEY_PREVIEW    = '0x4AAAAAAD6E9kz8K3comwjj';

// Nombres/prefijos que jamás deben viajar al navegador. Se busca la marca, no
// el valor: si algo coincide, se reporta la coincidencia sin imprimir nunca el
// contenido que la rodea.
const SECRET_MARKERS = [
  'MP_ACCESS_TOKEN',
  'MP_WEBHOOK_SECRET',
  'TURNSTILE_SECRET_KEY',
  'CLOUDFLARE_API_TOKEN',
  'APP_USR-',
  'access_token=',
];

// Exact property names that must not appear in JSON responses from API routes.
// Note: "has_error" is intentionally excluded — it is part of the public contract.
const INTERNAL_FIELDS = [
  'error', 'stack', 'stacktrace', 'exception',
  'cause', 'details', 'debug', 'raw_error',
];

const ROUTES = [
  { path: '/', kind: 'html', canonical: `${BASE_URL}/`, robots: 'index, follow' },
  { path: '/catalogo', kind: 'html', canonical: `${BASE_URL}/catalogo`, robots: 'index, follow' },
  { path: '/catalogo?q=zzzinexistente999', kind: 'html', canonical: `${BASE_URL}/catalogo`, robots: 'noindex, follow' },
  { path: '/pedir-libro', kind: 'html', canonical: `${BASE_URL}/pedir-libro`, robots: 'index, follow' },
  { path: '/como-identificar-edicion-correcta-isbn', kind: 'html', canonical: `${BASE_URL}/como-identificar-edicion-correcta-isbn`, robots: 'index, follow' },
  { path: '/carrito/', kind: 'cart' },
  { path: '/robots.txt', kind: 'robots' },
  { path: '/sitemap.xml', kind: 'sitemap-index' },
  { path: '/sitemap-pages.xml', kind: 'sitemap-pages' },
  { path: '/sitemap-categories.xml', kind: 'sitemap-categories' },
  { path: '/sitemap-books-active.xml', kind: 'sitemap-books-active' },
  { path: '/api/health' },
  { path: '/api/status' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hasContentType(headers, type) {
  return (headers.get('content-type') || '').includes(type);
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
    });
  } finally {
    clearTimeout(timer);
  }
}

function checkInternalFields(data, path) {
  for (const field of INTERNAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      return { ok: false, path, reason: `internal field exposed in response: "${field}"` };
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hasHtmlMeta(body, name, expected) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = body.match(new RegExp(`<meta\\s+name=["']${escaped}["'][^>]*>`, 'i'));
  return !!tag && tag[0].toLowerCase().includes(`content="${expected.toLowerCase()}"`);
}

function hasCanonical(body, expected) {
  const tags = body.match(/<link\s+[^>]*rel=["']canonical["'][^>]*>/gi) || [];
  return tags.some(tag => tag.includes(`href="${expected}"`));
}

// ─── Análisis del estado del checkout en /carrito/ ───────────────────────────

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detecta un elemento HTML realmente renderizado con ese id.
 *
 * Deliberadamente NO alcanza con que el id aparezca en cualquier parte del
 * documento: el bloque <script> del carrito contiene referencias inertes como
 * document.getElementById('cf-ts-container') incluso cuando el checkout está
 * apagado y el elemento nunca se renderiza. Por eso se exige la apertura de una
 * etiqueta (`<div ... id="...")`, y `[^>]*` no puede cruzar un `>`, así que una
 * cadena suelta dentro del script jamás satisface el patrón.
 */
function hasRenderedElementWithId(html, id) {
  const re = new RegExp(`<[a-zA-Z][a-zA-Z0-9-]*\\s[^>]*id=["']${escapeForRegExp(id)}["']`, 'i');
  return re.test(html);
}

function findSecretMarkers(html) {
  return SECRET_MARKERS.filter(marker => html.includes(marker));
}

/**
 * Analiza el HTML servido de /carrito/ contra el estado esperado del checkout.
 * Función pura: no hace red ni lee el entorno, para poder ejercitarla con
 * fixtures en los tests sin tocar Producción.
 *
 * @param {string} html          HTML crudo de /carrito/
 * @param {'enabled'|'disabled'} expectation
 * @returns {{ok: boolean, reason?: string}}
 */
function analyzeCartCheckoutState(html, expectation) {
  if (!VALID_CHECKOUT_EXPECTATIONS.includes(expectation)) {
    return {
      ok: false,
      reason: `SMOKE_EXPECT_CHECKOUT inválido: se esperaba ${VALID_CHECKOUT_EXPECTATIONS.join(' o ')}`,
    };
  }

  if (typeof html !== 'string' || html.trim().length === 0) {
    return { ok: false, reason: 'empty body' };
  }

  // Controles válidos en ambos estados.
  const secrets = findSecretMarkers(html);
  if (secrets.length > 0) {
    // Nunca se imprime el contenido: solo qué marcador coincidió.
    return { ok: false, reason: `posible secreto expuesto (marcador: ${secrets.join(', ')})` };
  }
  if (html.includes(TURNSTILE_SITE_KEY_PREVIEW)) {
    return { ok: false, reason: 'la Site key de Turnstile Preview aparece en Producción' };
  }
  // El cierre por WhatsApp nunca debe desaparecer: es la vía de compra que
  // funciona con el checkout online prendido o apagado.
  if (!hasRenderedElementWithId(html, 'btn-wa-order')) {
    return { ok: false, reason: 'falta el cierre por WhatsApp (btn-wa-order)' };
  }

  const marker           = `data-online-checkout="${expectation}"`;
  const hasPrepareButton = hasRenderedElementWithId(html, 'btn-prepare-order');
  const hasTurnstileBox  = hasRenderedElementWithId(html, 'cf-ts-container');

  if (!html.includes(marker)) {
    return { ok: false, reason: `falta ${marker}` };
  }

  if (expectation === 'enabled') {
    if (!hasPrepareButton) {
      return { ok: false, reason: 'falta el botón renderizado id="btn-prepare-order"' };
    }
    if (!hasTurnstileBox) {
      return { ok: false, reason: 'falta el contenedor renderizado de Turnstile (cf-ts-container)' };
    }
    if (!html.includes(TURNSTILE_SITE_KEY_PRODUCTION)) {
      return { ok: false, reason: 'falta la Site key de Turnstile Production' };
    }
    return { ok: true };
  }

  // expectation === 'disabled'
  if (hasPrepareButton) {
    return { ok: false, reason: 'btn-prepare-order sigue renderizado con el checkout apagado' };
  }
  if (hasTurnstileBox) {
    return { ok: false, reason: 'el contenedor de Turnstile sigue renderizado con el checkout apagado' };
  }
  return { ok: true };
}

function resolveCheckoutExpectation(rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!VALID_CHECKOUT_EXPECTATIONS.includes(value)) {
    return {
      ok: false,
      reason:
        'SMOKE_EXPECT_CHECKOUT debe valer exactamente "enabled" o "disabled" ' +
        `(recibido: ${value === '' ? '<sin definir>' : JSON.stringify(value)})`,
    };
  }
  return { ok: true, value };
}

function writeGitHubOutputs(attemptsUsed, result) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  fs.appendFileSync(outputFile, `attempts_used=${attemptsUsed}\n`);
  fs.appendFileSync(outputFile, `smoke_result=${result}\n`);
}

// ─── Sitemap validators ───────────────────────────────────────────────────────

function sitemapLocs(body) {
  return [...String(body || '').matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
}

function sitemapLastmods(body) {
  return [...String(body || '').matchAll(/<lastmod>([^<]+)<\/lastmod>/gi)].map(match => match[1]);
}

function isValidSitemapDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function analyzeSitemapBody(body, kind) {
  if (typeof body !== 'string' || !body.startsWith('<?xml')) {
    return { ok: false, reason: 'invalid XML declaration' };
  }
  if (/<(?:priority|changefreq)>/i.test(body)) {
    return { ok: false, reason: 'sitemap reintroduced priority/changefreq' };
  }

  const lastmods = sitemapLastmods(body);
  if (lastmods.length > 0 && kind !== 'sitemap-pages') {
    return { ok: false, reason: 'lastmod requires a reliable static-page revision date' };
  }
  if (lastmods.some(value => !isValidSitemapDate(value))) {
    return { ok: false, reason: 'sitemap contains invalid lastmod date' };
  }

  const locs = sitemapLocs(body);
  const allOnCanonicalHost = locs.every(value => value.startsWith(BASE_URL + '/'));
  if (!allOnCanonicalHost) return { ok: false, reason: 'sitemap contains non-canonical host/url' };

  if (kind === 'sitemap-index') {
    if (!body.includes('<sitemapindex ')) return { ok: false, reason: 'root sitemap is not a sitemapindex' };
    const required = [
      BASE_URL + '/sitemap-pages.xml',
      BASE_URL + '/sitemap-categories.xml',
      BASE_URL + '/sitemap-books-active.xml',
    ];
    for (const value of required) {
      if (!locs.includes(value)) return { ok: false, reason: 'sitemap index missing ' + value };
    }
    if (locs.some(value => value.includes('paused'))) {
      return { ok: false, reason: 'paused sitemap must not be in root index yet' };
    }
    if (locs.length !== required.length) {
      return { ok: false, reason: 'sitemap index has unexpected segmentos' };
    }
    return { ok: true };
  }

  if (!body.includes('<urlset ')) return { ok: false, reason: kind + ' is not a urlset' };

  if (kind === 'sitemap-pages') {
    const requiredPaths = [
      '/', '/catalogo', '/pedir-libro', '/libros-maria-montessori-uruguay', '/politicas', '/envios',
      '/devoluciones', '/terminos', '/privacidad', '/contacto',
    ];
    for (const path of requiredPaths) {
      const expected = BASE_URL + path;
      if (!locs.includes(expected)) return { ok: false, reason: 'sitemap pages missing ' + path };
    }
    return { ok: true };
  }

  if (kind === 'sitemap-categories') {
    if (locs.length === 0) return { ok: false, reason: 'category sitemap is empty' };
    if (!locs.every(value => value.startsWith(BASE_URL + '/libros/'))) {
      return { ok: false, reason: 'category sitemap contains non-category URL' };
    }
    return { ok: true };
  }

  if (kind === 'sitemap-books-active') {
    if (locs.length === 0) return { ok: false, reason: 'active books sitemap is empty' };
    if (!locs.every(value => value.startsWith(BASE_URL + '/libro/'))) {
      return { ok: false, reason: 'active books sitemap contains non-product URL' };
    }
    return { ok: true };
  }

  return { ok: false, reason: 'unknown sitemap kind' };
}

// ─── Route validators ─────────────────────────────────────────────────────────

async function checkRoute(path, checkoutExpectation) {
  const url = BASE_URL + path;
  let resp;

  try {
    resp = await fetchWithTimeout(url);
  } catch (err) {
    const reason = err.name === 'AbortError'
      ? `timeout after ${TIMEOUT_MS}ms`
      : `network error: ${err.message}`;
    return { ok: false, path, reason };
  }

  const { status } = resp;

  // ── HTML indexable/noindex routes ────────────────────────────────────────
  const route = ROUTES.find(r => r.path === path);
  if (route && route.kind === 'html') {
    if (status !== 200) {
      return { ok: false, path, reason: `HTTP ${status} (expected 200)` };
    }
    if (!hasContentType(resp.headers, 'text/html')) {
      return { ok: false, path, reason: `Content-Type not text/html (got: ${resp.headers.get('content-type') || 'none'})` };
    }
    const body = await resp.text();
    if (!body || body.trim().length === 0) {
      return { ok: false, path, reason: 'empty body' };
    }
    if (!hasCanonical(body, route.canonical)) {
      return { ok: false, path, reason: `missing canonical "${route.canonical}"` };
    }
    if (!hasHtmlMeta(body, 'robots', route.robots)) {
      return { ok: false, path, reason: `missing robots meta "${route.robots}"` };
    }
    return { ok: true, path };
  }

  // ── /carrito/ — estado del checkout (solo lectura del HTML) ──────────────
  if (route && route.kind === 'cart') {
    if (status !== 200) {
      return { ok: false, path, reason: `HTTP ${status} (expected 200)` };
    }
    if (!hasContentType(resp.headers, 'text/html')) {
      return { ok: false, path, reason: `Content-Type not text/html (got: ${resp.headers.get('content-type') || 'none'})` };
    }
    const body = await resp.text();
    const analysis = analyzeCartCheckoutState(body, checkoutExpectation);
    if (!analysis.ok) {
      return { ok: false, path, reason: `checkout esperado "${checkoutExpectation}": ${analysis.reason}` };
    }
    return { ok: true, path };
  }

  // ── /robots.txt ──────────────────────────────────────────────────────────
  if (path === '/robots.txt') {
    if (status !== 200) return { ok: false, path, reason: `HTTP ${status} (expected 200)` };
    if (!hasContentType(resp.headers, 'text/plain')) {
      return { ok: false, path, reason: `Content-Type not text/plain (got: ${resp.headers.get('content-type') || 'none'})` };
    }
    const body = await resp.text();
    if (!/^User-agent:/m.test(body) || !body.includes(`Sitemap: ${BASE_URL}/sitemap.xml`)) {
      return { ok: false, path, reason: 'invalid robots.txt body or missing sitemap directive' };
    }
    if (/<html|<!doctype/i.test(body)) {
      return { ok: false, path, reason: 'robots.txt returned HTML' };
    }
    return { ok: true, path };
  }

  // ── Sitemaps ──────────────────────────────────────────────────────────────
  if (route && route.kind && route.kind.startsWith('sitemap-')) {
    if (status !== 200) return { ok: false, path, reason: 'HTTP ' + status + ' (expected 200)' };
    if (!hasContentType(resp.headers, 'application/xml')) {
      return { ok: false, path, reason: 'Content-Type not XML (got: ' + (resp.headers.get('content-type') || 'none') + ')' };
    }
    const body = await resp.text();
    const analysis = analyzeSitemapBody(body, route.kind);
    if (!analysis.ok) return { ok: false, path, reason: analysis.reason };
    return { ok: true, path };
  }

  // ── /api/health ──────────────────────────────────────────────────────────
  if (path === '/api/health') {
    if (status !== 200) {
      return { ok: false, path, reason: `HTTP ${status} (expected 200)` };
    }
    if (!hasContentType(resp.headers, 'application/json')) {
      return { ok: false, path, reason: `Content-Type not JSON (got: ${resp.headers.get('content-type') || 'none'})` };
    }
    let data;
    try { data = await resp.json(); } catch { return { ok: false, path, reason: 'invalid JSON' }; }
    if (data.status !== 'OK') {
      return { ok: false, path, reason: `status="${data.status}" (expected "OK")` };
    }
    if (data.env !== 'prod') {
      return { ok: false, path, reason: `env="${data.env}" (expected "prod")` };
    }
    const leak = checkInternalFields(data, path);
    if (leak) return leak;
    return { ok: true, path };
  }

  // ── /api/status ──────────────────────────────────────────────────────────
  if (path === '/api/status') {
    if (status !== 200) {
      return { ok: false, path, reason: `HTTP ${status} (expected 200)` };
    }
    if (!hasContentType(resp.headers, 'application/json')) {
      return { ok: false, path, reason: `Content-Type not JSON (got: ${resp.headers.get('content-type') || 'none'})` };
    }
    let data;
    try { data = await resp.json(); } catch { return { ok: false, path, reason: 'invalid JSON' }; }

    if (data.status !== 'ok') {
      return { ok: false, path, reason: `status="${data.status}" (expected "ok")` };
    }
    if (data.healthy !== true) {
      return { ok: false, path, reason: `healthy=${JSON.stringify(data.healthy)} (expected true)` };
    }
    if (data.env !== 'prod') {
      return { ok: false, path, reason: `env="${data.env}" (expected "prod")` };
    }
    if (!data.catalog || data.catalog.available !== true) {
      return { ok: false, path, reason: `catalog.available=${JSON.stringify(data.catalog && data.catalog.available)} (expected true)` };
    }
    if (data.catalog.meta_available !== true) {
      return { ok: false, path, reason: `catalog.meta_available=${JSON.stringify(data.catalog.meta_available)} (expected true)` };
    }
    if (!data.worker || data.worker.sync_fresh !== true) {
      return { ok: false, path, reason: `worker.sync_fresh=${JSON.stringify(data.worker && data.worker.sync_fresh)} (expected true)` };
    }
    if (data.worker.has_error !== false) {
      return { ok: false, path, reason: `worker.has_error=${JSON.stringify(data.worker.has_error)} (expected false)` };
    }
    if (data.worker.possibly_stuck !== false) {
      return { ok: false, path, reason: `worker.possibly_stuck=${JSON.stringify(data.worker.possibly_stuck)} (expected false)` };
    }
    const leak = checkInternalFields(data, path);
    if (leak) return leak;
    return { ok: true, path };
  }

  return { ok: false, path, reason: 'unknown route (not handled)' };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const expectation = resolveCheckoutExpectation(process.env.SMOKE_EXPECT_CHECKOUT);
  if (!expectation.ok) {
    console.error(`[smoke] ${expectation.reason}`);
    process.exit(1);
  }
  const checkoutExpectation = expectation.value;

  console.log(`[smoke] Base URL:       ${BASE_URL}`);
  console.log(`[smoke] Max attempts:   ${MAX_ATTEMPTS}`);
  console.log(`[smoke] Retry delay:    ${RETRY_DELAY_MS}ms`);
  console.log(`[smoke] Timeout/route:  ${TIMEOUT_MS}ms`);
  console.log(`[smoke] Checkout esperado: ${checkoutExpectation}`);
  console.log('');

  const lastStatus = {};
  for (const r of ROUTES) lastStatus[r.path] = { ok: false, reason: 'not attempted' };

  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsUsed = attempt;
    console.log(`[smoke] ── Attempt ${attempt}/${MAX_ATTEMPTS} ─────────────────────────`);

    const results = await Promise.all(ROUTES.map(r => checkRoute(r.path, checkoutExpectation)));

    let allPassed = true;
    for (const r of results) {
      lastStatus[r.path] = r;
      const icon   = r.ok ? '✅' : '❌';
      const detail = r.ok ? 'OK' : r.reason;
      console.log(`  ${icon} ${r.path}  →  ${detail}`);
      if (!r.ok) allPassed = false;
    }

    if (allPassed) {
      console.log(`\n[smoke] All routes passed on attempt ${attempt}.`);
      writeGitHubOutputs(attemptsUsed, 'success');
      process.exit(0);
    }

    if (attempt < MAX_ATTEMPTS) {
      console.log(`\n[smoke] Retrying in ${RETRY_DELAY_MS / 1000}s...\n`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  // All attempts exhausted
  console.log('\n[smoke] FAILED — Final route status after all attempts:');
  for (const r of ROUTES) {
    const s    = lastStatus[r.path];
    const icon = s.ok ? '✅' : '❌';
    const msg  = s.ok ? 'OK' : s.reason;
    console.log(`  ${icon} ${r.path}  →  ${msg}`);
  }

  writeGitHubOutputs(attemptsUsed, 'failure');
  process.exit(1);
}

// Exportado para poder ejercitar el análisis con fixtures en los tests, sin
// red y sin tocar Producción. El smoke solo corre cuando se invoca el archivo
// directamente (node scripts/smoke-production.js).
module.exports = {
  analyzeCartCheckoutState,
  analyzeSitemapBody,
  resolveCheckoutExpectation,
  hasRenderedElementWithId,
  hasHtmlMeta,
  SMOKE_ROUTES: ROUTES,
  VALID_CHECKOUT_EXPECTATIONS,
  TURNSTILE_SITE_KEY_PRODUCTION,
  TURNSTILE_SITE_KEY_PREVIEW,
};

if (require.main === module) {
  main();
}
