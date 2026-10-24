#!/usr/bin/env node
// Carga manual de compras a proveedores desde un archivo JSON local.
//   SYNC_SECRET=... node scripts/purchases/import-purchases.mjs compras.json
// Acepta un documento, una lista o {"documents":[...]}; envía lotes de 20 a
// POST /purchases/import del Worker (idempotente). Imprime sólo conteos y
// errores: nunca precios ni contenido de las facturas.
import { readFile } from 'node:fs/promises';

const WORKER = process.env.WORKER_URL || 'https://amadolibros-sync.undiaes.workers.dev';
const BATCH = 20;

export async function importFile(path, { secret = process.env.SYNC_SECRET, fetchImpl = fetch, worker = WORKER } = {}) {
  if (!secret) throw new Error('Falta SYNC_SECRET');
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const docs = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.documents) ? parsed.documents : [parsed];
  const summary = { imported: 0, errors: [], review: 0 };
  for (let i = 0; i < docs.length; i += BATCH) {
    const res = await fetchImpl(`${worker}/purchases/import`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ documents: docs.slice(i, i + BATCH) }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error ?? 'error'}`);
    summary.imported += data.imported;
    for (const r of data.results) {
      if (r.status === 'error') summary.errors.push({ index: i + r.index, error: r.error });
      else summary.review += r.review.length;
    }
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('import-purchases.mjs')) {
  const path = process.argv[2];
  if (!path) { console.error('Uso: SYNC_SECRET=... node scripts/purchases/import-purchases.mjs compras.json'); process.exit(2); }
  importFile(path).then(s => { console.log(JSON.stringify(s, null, 2)); process.exit(s.errors.length ? 1 : 0); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
