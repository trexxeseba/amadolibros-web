// AUDITORIA-EXTERNA-25AGO2026 — utilidades compartidas de los scripts de auditoría.
//
// Reglas fijadas por el brief y no negociables desde los scripts que la usan:
//   - solo lectura contra producción;
//   - concurrencia máxima 5;
//   - 200 ms entre requests;
//   - User-Agent identificable;
//   - un único reintento ante fallo de red.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const BASE_URL = (process.env.AUDIT_BASE_URL || 'https://www.amadolibros.com').replace(/\/$/, '');
export const USER_AGENT = process.env.AUDIT_USER_AGENT
  || 'AmadoLibrosAudit/1.0 (auditoria interna; +https://www.amadolibros.com)';
export const CONCURRENCY = Math.min(5, Math.max(1, Number(process.env.AUDIT_CONCURRENCY) || 5));
export const DELAY_MS = Math.max(200, Number(process.env.AUDIT_DELAY_MS) || 200);

const OUTPUT_DATE = process.env.AUDIT_DATE || new Date().toISOString().slice(0, 10);
export const OUTPUT_DIR = process.env.AUDIT_OUTPUT_DIR || `reports/auditoria-${OUTPUT_DATE}`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Un solo reintento, como pide el brief. No hay backoff exponencial: si la
// segunda vez tampoco responde, el fallo se reporta como dato, no se oculta.
async function once(url, method, timeoutMs, redirect) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      redirect,
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      signal: controller.signal,
    });
    const body = method === 'GET' ? await response.text() : '';
    return {
      url,
      ok: true,
      status: response.status,
      finalUrl: response.url,
      redirected: response.redirected,
      location: response.headers.get('location') || null,
      contentType: response.headers.get('content-type') || '',
      headers: Object.fromEntries(response.headers),
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function request(url, { method = 'GET', timeoutMs = 30000, redirect = 'follow' } = {}) {
  try {
    return await once(url, method, timeoutMs, redirect);
  } catch (firstError) {
    await sleep(DELAY_MS);
    try {
      return await once(url, method, timeoutMs, redirect);
    } catch (secondError) {
      return {
        url, ok: false, status: 0, finalUrl: url, redirected: false, location: null,
        contentType: '', headers: {}, body: '',
        error: `${firstError.message} | reintento: ${secondError.message}`,
      };
    }
  }
}

// Pool de tamaño fijo con separación temporal por worker. Cada worker espera
// DELAY_MS entre sus propios pedidos, así el ritmo agregado queda acotado sin
// necesidad de un scheduler global.
export async function mapWithLimit(items, worker, limit = CONCURRENCY) {
  const values = [...items];
  const results = new Array(values.length);
  let cursor = 0;
  async function consume() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await worker(values[index], index);
      await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length || 1) }, consume));
  return results;
}

export async function writeReport(fileName, payload) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const target = path.join(OUTPUT_DIR, fileName);
  const text = typeof payload === 'string' ? payload : `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(target, text);
  console.log(`Escrito: ${target}`);
  return target;
}

// Los href y <loc> llegan escapados como HTML/XML. Sin esta normalización,
// una URL con dos parámetros se interpreta como si tuviera un parámetro
// literal llamado "amp;...", y el grafo de enlaces queda incompleto.
export function decodeHtml(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

export function absoluteUrls(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(match => decodeHtml(match[1]));
}

// Defensa doble: el auditor de sitemap usa redirect="manual" para conservar
// el 3xx original, pero si alguien vuelve a usar follow, response.redirected
// evita que ese salto sea contabilizado como un 200 directo.
export function summarizeUrlChecks(checked) {
  const notOk = checked.filter(row => row.status !== 200 || row.redirected);
  return {
    notOk,
    totals: {
      ok200: checked.length - notOk.length,
      notOk: notOk.length,
      redirects3xx: notOk.filter(row => (row.status >= 300 && row.status < 400) || row.redirected).length,
      errors4xx: notOk.filter(row => row.status >= 400 && row.status < 500).length,
      errors5xx: notOk.filter(row => row.status >= 500).length,
      networkFailures: notOk.filter(row => row.status === 0).length,
    },
  };
}

export function paginationVerdict({ anchorPaginationLinks, truncated, reachedCount, unreachedCount, medianDepth }) {
  if (anchorPaginationLinks === 0) {
    return 'H3 — los links de paginación NO son <a href> reales en el HTML servido';
  }
  if (truncated) {
    return 'INDETERMINADO — recorrido cortado por AUDIT_MAX_PAGES; subir el límite y repetir';
  }
  const hasDepthProblem = medianDepth !== null && medianDepth >= 4;
  if (unreachedCount > 0 && reachedCount > 0 && hasDepthProblem) {
    return 'MIXTO H1 + H2 — hay fichas demasiado profundas y otras que la paginación no cubre';
  }
  if (unreachedCount > 0) {
    return 'H2 — la paginación no cubre todas las huérfanas';
  }
  if (hasDepthProblem) {
    return 'H1 — las fichas aparecen, pero a demasiada profundidad de clic';
  }
  return 'NINGUNA DE LAS TRES — la paginación las enlaza y a poca profundidad; el 0 inlinks de Ahrefs sería límite del rastreo, no del sitio';
}
