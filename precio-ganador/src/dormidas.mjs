// Publicaciones "dormidas" de Amado Libros (sólo lee): con stock, sin visitas, y sin anuncio en Mercado Ads.
// Pedido de Seba (24/11/2026): armar campañas chicas para que Mercado Libre las descubra.
//
//   node precio-ganador/src/dormidas.mjs --cuenta libros --salida DIR [--stock 3] [--visitas 0] [--dias 30]
//
// Para cada publicación activa con stock suficiente lee las visitas del período y descarta las que ya
// tienen un anuncio (activo o pausado) en cualquier campaña: un anuncio vive en una sola campaña.
// Las reparte en 5 grupos por tema para cargar una campaña por grupo.
// El cliente es de sólo lectura (rechaza todo lo que no sea GET). El log sólo muestra conteos (el repo
// es público); títulos y precios van al archivo de salida (repo privado).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from '../../agentes-ml/src/ml.mjs';
import { idsActivos, detalle } from './publicaciones.mjs';

const ADV = 51659, SITE = 'MLU', H = { headers: { 'Api-Version': '2' } };
const sinTildes = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Grupo temático por título. Función pura; el orden importa (el primero que coincide gana).
export const GRUPOS = [
  ['tarot_oraculos', /\b(tarot|oraculo|oracle|lenormand|cartas? (de|del) |runas|astrolog|esoter|reiki|chakra|angeles|bruj|magia|pendulo|numerolog)/],
  ['biblias_religion', /\b(biblia|bible|rvr|catolic|evangel|cristian|oracion|rosario|jesus|dios|espiritu santo|devocional|salmos|iglesia|papa francisco|santo)/],
  ['infantil_juvenil', /\b(infantil|ninos|ninas|cuento|colorear|actividades|bebe|disney|pixar|dinosaurio|princesa|juvenil|harry potter|stickers|puzzle|rompecabezas|album)/],
  ['crecimiento_psicologia', /\b(autoayuda|psicolog|ansiedad|habitos|mindfulness|emocion|terapia|felicidad|autoestima|inversor|inversion|finanzas|riqueza|liderazgo|negocio|emprend|coaching|crianza|montessori)/],
];
export function grupoDe(titulo) {
  const t = sinTildes(titulo);
  for (const [nombre, re] of GRUPOS) if (re.test(t)) return nombre;
  return 'literatura_y_otros';
}

// ¿Es dormida? Activa, en pesos, con stock, pocas visitas y sin anuncio. Función pura.
export function esDormida(item, visitas, { stockMin = 3, visitasMax = 0, conAnuncio = new Set() } = {}) {
  if (!item || item.status !== 'active' || item.currency_id !== 'UYU') return false;
  if (!(Number(item.available_quantity) >= stockMin)) return false;
  if (visitas === null || visitas === undefined || Number(visitas) > visitasMax) return false;
  return !conAnuncio.has(item.id);
}

async function enParalelo(lista, n, fn) {
  const cola = [...lista];
  await Promise.all(Array.from({ length: n }, async () => { while (cola.length) await fn(cola.shift()); }));
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const cuenta = CUENTAS[opt('cuenta')];
  if (!cuenta || cuenta.clave !== 'libros') { console.error('Sólo --cuenta libros'); process.exit(2); }
  const stockMin = Number(opt('stock', 3)), visitasMax = Number(opt('visitas', 0)), dias = Number(opt('dias', 30)), salida = opt('salida', '.');
  const ml = crearCliente(fuenteTokenD1(cuenta), { intentos: 4, concurrencia: 4 }); // sólo lectura por defecto
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });

  // Publicaciones que ya tienen anuncio (activo o pausado), en cualquier campaña.
  const conAnuncio = new Set(); let grupos = 0, gruposSinItem = 0;
  const base = `/advertising/${SITE}/advertisers/${ADV}/product_ads`;
  for (const estado of ['active', 'paused']) {
    for (let off = 0; off < 9950; off += 50) {
      const r = await ml.get(`${base}/ad_groups/search?limit=50&offset=${off}&filters[statuses]=${estado}`, H);
      const res = r?.results ?? [];
      for (const g of res) {
        grupos++;
        if (g.ad_group_type === 'ITEM' && g.ad_group_external_id) { conAnuncio.add(String(g.ad_group_external_id)); continue; }
        try { const a = await ml.get(`/advertising/${SITE}/product_ads/ad_groups/${g.id}/ads`, H); for (const x of a?.results ?? []) if (x.item_id) conAnuncio.add(String(x.item_id)); }
        catch (e) { if (e?.status === 429) throw e; gruposSinItem++; }
      }
      if (res.length < 50) break;
    }
  }

  const items = [...(await detalle(ml, await idsActivos(ml, cuenta.sellerId))).values()];
  const conStock = items.filter(i => i.status === 'active' && i.currency_id === 'UYU' && Number(i.available_quantity) >= stockMin);
  const filas = []; let sinVisitas = 0, erroresVisitas = 0;
  await enParalelo(conStock, 4, async it => {
    const r = await ml.sonda(`/items/${it.id}/visits/time_window?last=${dias}&unit=day`);
    if (!r.ok) { erroresVisitas++; return; }
    const v = Number(r.json?.total_visits ?? 0);
    if (v <= visitasMax) sinVisitas++;
    if (!esDormida(it, v, { stockMin, visitasMax, conAnuncio })) return;
    filas.push({ id: it.id, titulo: String(it.title ?? '').slice(0, 80), precio: Number(it.price), stock: Number(it.available_quantity), visitas: v, catalogo: !!it.catalog_listing, grupo: grupoDe(it.title) });
  });
  filas.sort((a, b) => a.grupo.localeCompare(b.grupo) || b.stock - a.stock);
  const porGrupo = {}; for (const f of filas) porGrupo[f.grupo] = (porGrupo[f.grupo] ?? 0) + 1;
  const resumen = { fecha: new Date().toISOString().slice(0, 10), cuenta: cuenta.clave, dias, stock_minimo: stockMin, visitas_maximas: visitasMax, activas: items.length, con_stock: conStock.length,
    con_pocas_visitas: sinVisitas, errores_visitas: erroresVisitas, grupos_de_anuncios: grupos, grupos_sin_leer: gruposSinItem, publicaciones_con_anuncio: conAnuncio.size, dormidas: filas.length, por_grupo: porGrupo };
  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, `${cuenta.clave}-dormidas.json`), JSON.stringify({ resumen, filas }, null, 1));
  console.log(JSON.stringify(resumen)); // sólo conteos: el log es público
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('dormidas:', e?.code ?? e?.message); process.exit(1); });
