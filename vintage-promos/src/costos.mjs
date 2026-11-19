// Piso por publicación de Amado Vintage para el informe de promociones. Mismo cálculo que
// precio-ganador/src/costos-vintage.mjs (costo según la lista de SBS y la política aprobada,
// margen mínimo de 18 %), pero leyendo la lista NUEVA de SBS (sbs_supplier_feeds /
// sbs_supplier_stock), que es donde la carga hoy el motor. Sólo SELECT.
import { quoteMercadoLibre } from '../../worker-sync/publication-policy.js';
import { vintageCompetitivePolicy } from '../../worker-sync/vintage-pricing.js';
import { D1_DATABASE_ID } from '../../precio-ganador/src/config.mjs';

export const MAX_DIAS_LISTA = 7;
export const SELLER_VINTAGE = '2341378249';

async function d1(sql, params = []) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const tokens = [process.env.CLOUDFLARE_ADMIN_API_TOKEN, process.env.CLOUDFLARE_API_TOKEN].filter(Boolean);
  let ultimo = 'sin_token_cloudflare';
  for (const t of tokens) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${D1_DATABASE_ID}/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(60000),
    }).catch(() => null);
    if (!res) { ultimo = 'cloudflare_transporte'; continue; }
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.success === false) { ultimo = `cloudflare_http_${res.status}`; continue; }
    return body?.result?.[0]?.results ?? [];
  }
  throw Object.assign(new Error(ultimo), { fatal: true });
}

// Origen de una publicación según su SKU (de dónde viene el costo).
export function origenDe(item) {
  const sku = String(item?.seller_custom_field ?? '');
  if (/^AMADO-AR-\d{10,13}$/.test(sku)) return 'sbs';
  if (/^ARNOIA-/.test(sku)) return 'arnoia';
  if (/^HERMES-/.test(sku)) return 'hermes';
  return 'otro';
}

// Puro: arma pisoDe(item) desde las filas de la lista (Map isbn -> fila) y la política.
export function crearPisoDe(filas, politica, ahora = Date.now()) {
  return item => {
    const isbn = /^AMADO-AR-(\d{10,13})$/.exec(item?.seller_custom_field ?? '')?.[1];
    const fila = isbn ? filas.get(isbn) : null;
    if (!fila) return null;
    try {
      // Un competidor ficticio a 1 peso obliga al cálculo a devolver el piso.
      const q = quoteMercadoLibre({ ...fila, competitor: { price: 1, at: ahora, days: politica.availabilityDays ?? null } }, politica);
      const piso = Number(q?.competitive?.floor);
      return Number.isFinite(piso) && piso > 0 ? piso : null;
    } catch { return null; }
  };
}

export async function cargarPisos() {
  const [run] = await d1(`SELECT id, policy_json FROM ml_vintage_pub_runs WHERE seller_id='${SELLER_VINTAGE}' ORDER BY updated_at DESC LIMIT 1`);
  if (!run) throw Object.assign(new Error('vintage_sin_politica'), { fatal: true });
  const politica = vintageCompetitivePolicy(JSON.parse(run.policy_json));
  const feeds = await d1('SELECT id, source_date, state, expected_rows FROM sbs_supplier_feeds ORDER BY source_date DESC LIMIT 5');
  let feed = null;
  for (const f of feeds) {
    const [c] = await d1('SELECT COUNT(*) AS n FROM sbs_supplier_stock WHERE feed_id = ?', [f.id]);
    if (Number(c?.n) >= Math.max(1000, Number(f.expected_rows || 0) * 0.9)) { feed = { ...f, renglones: Number(c.n) }; break; }
  }
  if (!feed) throw Object.assign(new Error('vintage_sin_lista_sbs'), { fatal: true });
  const dias = (Date.now() - Date.parse(feed.source_date)) / 86400e3;
  const vigente = Number.isFinite(dias) && dias <= MAX_DIAS_LISTA;
  const filas = new Map();
  if (vigente) for (let offset = 0; ; offset += 5000) {
    const parte = await d1('SELECT isbn, data_json FROM sbs_supplier_stock WHERE feed_id = ? ORDER BY isbn LIMIT 5000 OFFSET ?', [feed.id, offset]);
    for (const r of parte) filas.set(String(r.isbn), JSON.parse(r.data_json));
    if (parte.length < 5000) break;
  }
  return {
    pisoDe: crearPisoDe(filas, politica),
    info: { feed_id: feed.id, lista_sbs: feed.source_date, dias_lista: Math.round(dias * 10) / 10, lista_vigente: vigente, renglones: filas.size, margen_piso: politica.competitiveFloorMargin, minimo_politica: politica.competitiveMinimumSaleUyu },
  };
}
