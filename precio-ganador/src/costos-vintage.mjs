// Piso por publicación de Amado Vintage, con el mismo cálculo que usa el motor de
// la PC (worker-sync/publication-policy.js): costo del libro según la lista de SBS
// y la política aprobada, margen mínimo del 18 %, contribución mínima. Encima de
// eso, el mínimo absoluto que fijó Seba para este sistema (UYU 1.500).
//
// Se lee de D1 por la API de Cloudflare (sólo SELECT):
//   ml_vintage_pub_runs  → la política aprobada y la lista de SBS (feed) vigente
//   ml_pub_stock         → el renglón de SBS de cada ISBN (precio de lista, peso)
// Una publicación sin renglón en la lista no tiene costo conocido: no se baja.
import { quoteMercadoLibre } from '../../worker-sync/publication-policy.js';
import { vintageCompetitivePolicy } from '../../worker-sync/vintage-pricing.js';
import { D1_DATABASE_ID } from './config.mjs';

export const MINIMO_VINTAGE_UYU = 1500;
export const MAX_DIAS_LISTA = 7;

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

// Devuelve { pisoDe(item) → número | null, info }.
export async function cargarPisosVintage() {
  const [run] = await d1("SELECT id, policy_json, updated_at FROM ml_vintage_pub_runs WHERE seller_id='2341378249' ORDER BY updated_at DESC LIMIT 1");
  if (!run) throw Object.assign(new Error('vintage_sin_politica'), { fatal: true });
  const politica = vintageCompetitivePolicy(JSON.parse(run.policy_json));
  // La lista de SBS más nueva que esté completa en D1 (la carga renew.mjs desde la PC).
  const feeds = await d1('SELECT id, source_date, state, expected_rows FROM ml_pub_feeds ORDER BY created_at DESC LIMIT 10');
  let feed = null;
  for (const f of feeds) {
    const [c] = await d1('SELECT COUNT(*) AS n FROM ml_pub_stock WHERE feed_id = ?', [f.id]);
    if (Number(c?.n) >= Math.max(1000, Number(f.expected_rows || 0) * 0.9)) { feed = { ...f, renglones: Number(c.n) }; break; }
  }
  if (!feed) throw Object.assign(new Error('vintage_sin_lista_sbs'), { fatal: true });
  // Una lista vieja subestima el costo (los precios en pesos argentinos suben): con más
  // de MAX_DIAS_LISTA días no se baja ningún precio.
  const dias = (Date.now() - Date.parse(feed.source_date)) / 86400e3;
  const vigente = Number.isFinite(dias) && dias <= MAX_DIAS_LISTA;
  const filas = new Map();
  if (vigente) for (let offset = 0; ; offset += 5000) {
    const parte = await d1('SELECT isbn, data_json FROM ml_pub_stock WHERE feed_id = ? ORDER BY isbn LIMIT 5000 OFFSET ?', [feed.id, offset]);
    for (const r of parte) filas.set(String(r.isbn), JSON.parse(r.data_json));
    if (parte.length < 5000) break;
  }
  const pisoDe = item => {
    const isbn = /^AMADO-AR-(\d{10,13})$/.exec(item.seller_custom_field ?? '')?.[1];
    const fila = isbn ? filas.get(isbn) : null;
    if (!fila) return null;
    try {
      // Un competidor ficticio a 1 peso obliga al cálculo a devolver el piso.
      const q = quoteMercadoLibre({ ...fila, competitor: { price: 1, at: Date.now(), days: politica.availabilityDays ?? null } }, politica);
      const piso = Number(q?.competitive?.floor);
      return Number.isFinite(piso) && piso > 0 ? Math.max(piso, MINIMO_VINTAGE_UYU) : null;
    } catch { return null; }
  };
  return { pisoDe, info: { feed_id: feed.id, lista_sbs: feed.source_date, dias_lista: Math.round(dias * 10) / 10, lista_vigente: vigente, renglones: filas.size, margen_piso: politica.competitiveFloorMargin, minimo: MINIMO_VINTAGE_UYU } };
}
