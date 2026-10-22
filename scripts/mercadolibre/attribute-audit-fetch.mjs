#!/usr/bin/env node

// Baja los atributos crudos de las publicaciones activas de Amado Libros desde la
// ruta de SOLO LECTURA del Worker (/attribute-audit) y los deja en un JSON que
// consume `attribute-audit.mjs --raw`. No escribe nada en Mercado Libre.
//
// Requiere SYNC_SECRET. Uso:
//   SYNC_SECRET=... node scripts/mercadolibre/attribute-audit-fetch.mjs [salida.json]

import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://amadolibros-sync.undiaes.workers.dev';
const MAX_PAGES = 400;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Sólo tipos, banderas y contadores: nunca cursores, credenciales ni el cuerpo crudo.
export function auditPageShape(body) {
  return {
    body_type: body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body,
    read_only_matches: body?.read_only === true,
    seller_matches: body?.seller_id === '440298103',
    items_count: Array.isArray(body?.items) ? body.items.length : null,
    failed_ids_count: Array.isArray(body?.failed_ids) ? body.failed_ids.length : null,
    page_empty: typeof body?.page_empty === 'boolean' ? body.page_empty : null,
    scroll_id_kind: body?.scroll_id === null ? 'null' : typeof body?.scroll_id === 'string' ? (body.scroll_id.trim() ? 'nonempty_string' : 'empty_string') : typeof body?.scroll_id,
    total: Number.isInteger(body?.total) && body.total >= 0 ? body.total : null,
    total_kind: body?.total === null ? 'null' : typeof body?.total,
  };
}

function validatePage(body, page, { allowEmptyTerminalCursor = false } = {}) {
  const id = value => typeof value === 'string' && /^MLU\d+$/.test(value);
  if (!body || Array.isArray(body) || body.read_only !== true || body.seller_id !== '440298103' ||
      !Array.isArray(body.items) || !Array.isArray(body.failed_ids) ||
      typeof body.page_empty !== 'boolean' ||
      !(body.scroll_id === null || (allowEmptyTerminalCursor && body.scroll_id === '') || (typeof body.scroll_id === 'string' && body.scroll_id.trim())) ||
      !(body.total === null || (Number.isInteger(body.total) && body.total >= 0)) ||
      body.items.some(item => !id(item?.id)) || body.failed_ids.some(value => !id(value)) ||
      (body.page_empty && (body.items.length || body.failed_ids.length)) ||
      (!body.page_empty && !body.items.length && !body.failed_ids.length)) {
    throw new Error(`Página ${page}: respuesta de auditoría inválida o incompleta`);
  }
}

export async function fetchAllItems({ secret, fetcher = fetch, wait = sleep, origin = ORIGIN, retries = 4 } = {}) {
  if (!secret) throw new Error('SYNC_SECRET no está configurado');
  const items = new Map();
  const failed = new Set();
  let scrollId = null;
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let body;
    let completeWithEmptyCursor = false;
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetcher(new URL('/attribute-audit', origin), {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(scrollId ? { scroll_id: scrollId } : {}),
        redirect: 'manual',
      });
      body = await response.json().catch(() => ({}));
      if (response.ok) {
        // MLU termina algunos scans con scroll_id="". Sólo es un cierre válido
        // cuando una página realmente vacía confirma la cobertura ya obtenida.
        completeWithEmptyCursor = body?.scroll_id === '' && body?.page_empty === true &&
          Array.isArray(body?.items) && body.items.length === 0 &&
          Array.isArray(body?.failed_ids) && body.failed_ids.length === 0 &&
          items.size > 0 && failed.size === 0 && Number.isInteger(body.total) &&
          body.total === total && body.total === items.size;
        try { validatePage(body, page, { allowEmptyTerminalCursor: completeWithEmptyCursor }); }
        catch (error) {
          error.auditDiagnostics = { complete: false, page, items_read: items.size, failed_count: failed.size, reported_total: total, shape: auditPageShape(body) };
          error.incompleteAudit = { complete: false, read_only: true, seller_id: '440298103', items: [...items.values()], failed_ids: [...failed], total, pages: page - 1 };
          throw error;
        }
        break;
      }
      if (attempt >= retries || ![429, 502, 503].includes(response.status)) {
        throw new Error(`Página ${page}: ${body.error || response.status}`);
      }
      await wait(attempt * 3000);
    }
    total = body.total ?? total;
    for (const item of body.items) { items.set(item.id, item); failed.delete(item.id); }
    for (const id of body.failed_ids) if (!items.has(id)) failed.add(id);
    if (body.scroll_id === null || body.page_empty) {
      if (failed.size || total === null || items.size !== total) {
        throw new Error(`Auditoría incompleta: ${items.size} publicaciones leídas de ${total ?? '?'}; ${failed.size} sin poder leer. Repetir antes de generar un informe.`);
      }
      return { items: [...items.values()], failed_ids: [], total, pages: page,
        ...(completeWithEmptyCursor ? { completion: 'empty_terminal_cursor_with_full_coverage' } : {}) };
    }
    scrollId = body.scroll_id;
    await wait(300);
  }
  throw new Error(`Se superó el máximo de ${MAX_PAGES} páginas sin terminar el recorrido`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] || 'mlu-items-raw.json';
  fetchAllItems({ secret: process.env.SYNC_SECRET })
    .then(async result => {
      await writeFile(out, JSON.stringify(result));
      console.log(`Leídas ${result.items.length} de ${result.total ?? '?'} activas en ${result.pages} páginas; ${result.failed_ids.length} sin poder leer. Salida: ${out}`);
    })
    .catch(async error => {
      if (error.auditDiagnostics) {
        await writeFile(`${out}.diagnostics.json`, JSON.stringify(error.auditDiagnostics));
        await writeFile(`${out}.incomplete.json`, JSON.stringify(error.incompleteAudit));
        console.error(`Diagnóstico de formato: ${JSON.stringify(error.auditDiagnostics)}`);
      }
      console.error(error.message);
      process.exitCode = 1;
    });
}
