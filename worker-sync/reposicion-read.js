// POST /operations/reposicion — lectura firmada para GPT ("Amado Operaciones")
// de los hechos del motor de reposición: ventas ML por ISBN, compras, stock
// propio, disponibilidad SBS y banderas FUENTE INCOMPLETA / REVISAR.
//
// Mismo sobre que /operations/read (Amado-Signature, ECDSA P-256, misma clave
// pública) con aud "amado-reposicion-read". Cada jti se usa una sola vez
// (ml_pub_nonces). Sólo lee D1 y R2: no llama a Mercado Libre ni escribe datos.
// No calcula URGENTE / COMPRAR N / NO REPONER: entrega los hechos para decidir.
import { OPERATIONS_PUBLIC_KEY, OPERATIONS_ISSUER } from './operations-read.js';
import { salesByTitle, SALES_SELLER_ID } from './ml-sales.js';
import { purchasesByTitle } from './purchases.js';
import { createReposicionFacts, ownStockIndex } from './reposicion-facts.js';
import { listOpportunities, opportunitySummary, OPPORTUNITY_STATES } from './oportunidades.js';
import { loadBookTable } from '../functions/_shared/panel-bi.js';
import { longTailReview, loadVisitsIndex } from './long-tail.js';
import { radarExterno, listImports, stockDiscrepancies } from './importacion-externa.js';

export { ownStockIndex };

export const REPOSICION_PATH = '/operations/reposicion';
export const REPOSICION_AUD = 'amado-reposicion-read';
const ACTIONS = ['estado', 'reposicion_hechos', 'candidatos', 'ventas_titulo', 'compras_titulo', 'revision_identidad', 'competencia_hoy', 'competencia_cobertura', 'oportunidades', 'long_tail', 'radar_externo', 'stock_discrepancias'];

class RepoError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }
const reply = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const decode = v => { if (!/^[A-Za-z0-9_-]+$/.test(v)) throw new Error('enc'); return Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(v.length / 4) * 4, '=')), c => c.charCodeAt(0)); };

export async function verifyReposicionRequest(request, { now = Date.now, publicKey = OPERATIONS_PUBLIC_KEY } = {}) {
  const auth = request.headers.get('authorization') || '';
  try {
    if (request.method !== 'POST' || new URL(request.url).pathname !== REPOSICION_PATH || auth.length > 8192 || !auth.startsWith('Amado-Signature ')) throw new Error('env');
    const parts = auth.slice(16).split('.');
    if (parts.length !== 2) throw new Error('env');
    const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decode(parts[1]), new TextEncoder().encode(parts[0]))) throw new Error('sig');
    const p = JSON.parse(new TextDecoder().decode(decode(parts[0]))), seconds = Math.floor(now() / 1000);
    if (p.v !== 1 || p.iss !== OPERATIONS_ISSUER || p.aud !== REPOSICION_AUD || p.method !== 'POST' || p.path !== REPOSICION_PATH || p.seller_id !== SALES_SELLER_ID
      || !Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.exp <= seconds || p.iat > seconds + 15 || p.exp - p.iat > 60 || p.exp <= p.iat || !/^[a-f0-9-]{36}$/.test(p.jti)) throw new Error('claims');
    return p;
  } catch { throw new RepoError('unauthorized_or_expired', 401); }
}

async function useNonce(db, jti, expiresMs, nowMs) {
  await db.prepare('CREATE TABLE IF NOT EXISTS ml_pub_nonces (id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL)').run();
  await db.prepare('DELETE FROM ml_pub_nonces WHERE expires_at<?').bind(nowMs).run();
  try { await db.prepare('INSERT INTO ml_pub_nonces(id,expires_at) VALUES(?,?)').bind(`rep:${jti}`, expiresMs).run(); }
  catch { throw new RepoError('request_already_used', 409); }
}

function args(raw, fields) {
  const a = raw ?? {};
  if (typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !fields.includes(k))) throw new RepoError('invalid_args');
  return a;
}
const isbnList = a => { if (!Array.isArray(a.isbns) || a.isbns.length < 1 || a.isbns.length > 50) throw new RepoError('isbns_1_to_50'); return a.isbns; };
const titleArg = a => { const t = String(a.titulo ?? '').trim(); if (t.length < 3 || t.length > 120) throw new RepoError('titulo_3_to_120'); return t; };
const limitArg = (a, max) => Math.min(max, Math.max(1, Number.isInteger(a.limite) ? a.limite : 20));

export function createReposicionReader({ now = Date.now, publicKey = OPERATIONS_PUBLIC_KEY } = {}) {
  let engine = null;
  // El Worker lee catalog.json directo de R2 (binding CATALOG_R2).
  const factsFor = env => engine ??= createReposicionFacts({ now, loadCatalog: async () => { const obj = await env.CATALOG_R2?.get('catalog.json'); return obj ? obj.json() : null; } });

  async function run(action, a, env, db) {
    const f = factsFor(env);
    if (action === 'estado') {
      const g = await f.globalState(db);
      return { salud: g.health, catalogo_actualizado: g.catalog_updated_at, cobertura_compras: g.coverage, proveedores_sin_cobertura: g.missing, advertencias_globales: g.flags };
    }
    if (action === 'reposicion_hechos') return f.facts(db, isbnList(args(a, ['isbns'])));
    if (action === 'candidatos') return f.candidates(db, limitArg(args(a, ['limite']), 50));
    if (action === 'ventas_titulo') return { resultados: await salesByTitle(db, titleArg(args(a, ['titulo'])), now()) };
    if (action === 'compras_titulo') return { resultados: await purchasesByTitle(db, titleArg(args(a, ['titulo']))) };
    if (action === 'revision_identidad') return f.identityQueue(db, limitArg(args(a, ['limite']), 100));
    if (action === 'competencia_hoy') return f.events(db, limitArg(args(a, ['limite']), 100));
    if (action === 'competencia_cobertura') { args(a, []); return f.coverage(db); }
    if (action === 'long_tail') {
      const o = args(a, ['categoria', 'limite']);
      const catalog = await env.CATALOG_R2?.get('catalog.json').then(obj => (obj ? obj.json() : null)).catch(() => null);
      const table = await loadBookTable(db, catalog, now());
      const review = longTailReview({ books: table.books, stock: table.stock, meta: table.meta, visits: await loadVisitsIndex(db, now()), catalog, nowMs: now() });
      const cat = o.categoria == null ? null : String(o.categoria);
      const lim = limitArg(o, 200);
      return { ...review, listas: Object.fromEntries(Object.entries(review.listas).map(([k, v]) => [k, v.slice(0, lim)])), pares: review.pares.slice(0, lim), categoria: cat, ...(cat ? { titulos: review.listas[cat] ? review.listas[cat].slice(0, lim) : [] } : {}) };
    }
    if (action === 'radar_externo') {
      const o = args(a, ['limite']);
      const catalog = await env.CATALOG_R2?.get('catalog.json').then(obj => (obj ? obj.json() : null)).catch(() => null);
      return { cargas: await listImports(db, 20), radar: await radarExterno(db, catalog, { limit: limitArg(o, 200), nowMs: now() }) };
    }
    if (action === 'stock_discrepancias') {
      const o = args(a, ['limite']);
      const catalog = await env.CATALOG_R2?.get('catalog.json').then(obj => (obj ? obj.json() : null)).catch(() => null);
      return stockDiscrepancies(db, catalog, { limit: limitArg(o, 200), nowMs: now() });
    }
    if (action === 'oportunidades') {
      const o = args(a, ['estado', 'limite']);
      const estado = o.estado == null ? 'pendiente' : String(o.estado);
      if (estado !== 'todas' && !OPPORTUNITY_STATES.includes(estado)) throw new RepoError('invalid_args');
      return { resumen: await opportunitySummary(db, now()), oportunidades: await listOpportunities(db, { estado, limit: limitArg(o, 200), nowMs: now() }) };
    }
    throw new RepoError('unknown_action');
  }

  return async function handle(request, env) {
    try {
      const p = await verifyReposicionRequest(request, { now, publicKey });
      if (!ACTIONS.includes(p.action)) throw new RepoError('unknown_action');
      const db = env?.ORDERS_DB;
      if (!db) throw new RepoError('storage_not_configured', 503);
      await useNonce(db, p.jti, p.exp * 1000, now());
      const data = await run(p.action, p.args, env, db);
      return reply({ source: 'Amado D1', action: p.action, read_only: true, data });
    } catch (error) {
      return reply({ error: error instanceof RepoError ? error.code : 'internal_error' }, error instanceof RepoError ? error.status : 500);
    }
  };
}

export const handleReposicionRead = createReposicionReader();
