#!/usr/bin/env node
/**
 * scripts/smoke-production.js
 *
 * Post-deploy smoke tests for amadolibros.com.
 * Uses only Node.js 22 native APIs — no external dependencies.
 *
 * Configuration via environment variables:
 *   SMOKE_BASE_URL        default: https://www.amadolibros.com
 *   SMOKE_MAX_ATTEMPTS    default: 6
 *   SMOKE_RETRY_DELAY_MS  default: 10000
 *   SMOKE_TIMEOUT_MS      default: 10000
 */

'use strict';

const fs = require('fs');

const BASE_URL       = process.env.SMOKE_BASE_URL       || 'https://www.amadolibros.com';
const MAX_ATTEMPTS   = parseInt(process.env.SMOKE_MAX_ATTEMPTS   || '6',     10);
const RETRY_DELAY_MS = parseInt(process.env.SMOKE_RETRY_DELAY_MS || '10000', 10);
const TIMEOUT_MS     = parseInt(process.env.SMOKE_TIMEOUT_MS     || '10000', 10);

// Exact property names that must not appear in JSON responses from API routes.
// Note: "has_error" is intentionally excluded — it is part of the public contract.
const INTERNAL_FIELDS = [
  'error', 'stack', 'stacktrace', 'exception',
  'cause', 'details', 'debug', 'raw_error',
];

const ROUTES = [
  { path: '/', kind: 'html', canonical: `${BASE_URL}/`, robots: 'index, follow' },
  { path: '/catalogo', kind: 'html', canonical: `${BASE_URL}/catalogo`, robots: 'index, follow' },
  { path: '/catalogo?q=zzzinexistente999', kind: 'html', canonical: `${BASE_URL}/catalogo`, robots: 'noindex' },
  { path: '/robots.txt', kind: 'robots' },
  { path: '/sitemap.xml', kind: 'sitemap' },
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

function writeGitHubOutputs(attemptsUsed, result) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  fs.appendFileSync(outputFile, `attempts_used=${attemptsUsed}\n`);
  fs.appendFileSync(outputFile, `smoke_result=${result}\n`);
}

// ─── Route validators ─────────────────────────────────────────────────────────

async function checkRoute(path) {
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

  // ── /sitemap.xml ─────────────────────────────────────────────────────────
  if (path === '/sitemap.xml') {
    if (status !== 200) return { ok: false, path, reason: `HTTP ${status} (expected 200)` };
    if (!hasContentType(resp.headers, 'application/xml')) {
      return { ok: false, path, reason: `Content-Type not XML (got: ${resp.headers.get('content-type') || 'none'})` };
    }
    const body = await resp.text();
    if (!body.startsWith('<?xml') || !body.includes('<urlset ') || !body.includes(`<loc>${BASE_URL}/</loc>`)) {
      return { ok: false, path, reason: 'invalid sitemap XML body' };
    }
    if (body.includes(`<loc>${BASE_URL}/politicas</loc>`)) {
      return { ok: false, path, reason: 'sitemap includes unavailable /politicas page' };
    }
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
  console.log(`[smoke] Base URL:       ${BASE_URL}`);
  console.log(`[smoke] Max attempts:   ${MAX_ATTEMPTS}`);
  console.log(`[smoke] Retry delay:    ${RETRY_DELAY_MS}ms`);
  console.log(`[smoke] Timeout/route:  ${TIMEOUT_MS}ms`);
  console.log('');

  const lastStatus = {};
  for (const r of ROUTES) lastStatus[r.path] = { ok: false, reason: 'not attempted' };

  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsUsed = attempt;
    console.log(`[smoke] ── Attempt ${attempt}/${MAX_ATTEMPTS} ─────────────────────────`);

    const results = await Promise.all(ROUTES.map(r => checkRoute(r.path)));

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

main();
