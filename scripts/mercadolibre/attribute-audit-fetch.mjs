#!/usr/bin/env node

// Baja los atributos crudos de las publicaciones activas de Amado Libros desde la
// ruta de SOLO LECTURA del Worker (/attribute-audit) y los deja en un JSON que
// consume `attribute-audit.mjs --raw`. No escribe nada en Mercado Libre.
//
// Requiere SYNC_SECRET. Uso:
//   SYNC_SECRET=... node scripts/mercadolibre/attribute-audit-fetch.mjs [salida.json]

import { writeFile } from 'node:fs/promises';

const ORIGIN = 'https://amadolibros-sync.undiaes.workers.dev';
const MAX_PAGES = 400;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function fetchAllItems({ secret, fetcher = fetch, wait = sleep, origin = ORIGIN, retries = 4 } = {}) {
  if (!secret) throw new Error('SYNC_SECRET no está configurado');
  const items = new Map();
  const failed = new Set();
  let scrollId = null;
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let body;
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetcher(new URL('/attribute-audit', origin), {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(scrollId ? { scroll_id: scrollId } : {}),
        redirect: 'manual',
      });
      body = await response.json().catch(() => ({}));
      if (response.ok) break;
      if (attempt >= retries || ![429, 502, 503].includes(response.status)) {
        throw new Error(`Página ${page}: ${body.error || response.status}`);
      }
      await wait(attempt * 3000);
    }
    total = body.total ?? total;
    for (const item of body.items || []) items.set(item.id, item);
    for (const id of body.failed_ids || []) failed.add(id);
    if (!body.scroll_id || body.page_empty) return { items: [...items.values()], failed_ids: [...failed], total, pages: page };
    scrollId = body.scroll_id;
    await wait(300);
  }
  throw new Error(`Se superó el máximo de ${MAX_PAGES} páginas sin terminar el recorrido`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const out = process.argv[2] || 'mlu-items-raw.json';
  fetchAllItems({ secret: process.env.SYNC_SECRET })
    .then(async result => {
      await writeFile(out, JSON.stringify(result));
      console.log(`Leídas ${result.items.length} de ${result.total ?? '?'} activas en ${result.pages} páginas; ${result.failed_ids.length} sin poder leer. Salida: ${out}`);
    })
    .catch(error => { console.error(error.message); process.exit(1); });
}
