// Competencia del mismo libro. Para cada producto de catálogo se leen las ofertas
// de la ficha (/products/{id}/items) y, para nuestra publicación de catálogo, el
// estado de competencia (/items/{id}/price_to_win). Las publicaciones sin ficha
// se buscan por ISBN en /products/search (la búsqueda general /sites/MLU/search
// está cerrada para esta cuenta: 403).
//
// Cada consulta registra fecha, fuente y alcance. Una consulta fallida o
// incompleta deja el caso en "insuficiente": nunca se traduce en "sin competencia".
import { SELLER_ID, SITE_ID } from './config.mjs';
import { manufacturingDays } from './publicaciones.mjs';
import { normalizeIsbn } from './isbn.mjs';

const normOffer = o => ({
  item_id: o.item_id ?? o.id, vendedor: String(o.seller_id ?? ''), precio: Number(o.price), moneda: o.currency_id ?? null,
  condicion: o.condition ?? null, internacional: typeof o.international_delivery_mode === 'string' ? o.international_delivery_mode !== 'none' : null,
  envio_gratis: o.shipping?.free_shipping === true, logistica: o.shipping?.logistic_type ?? null,
  // El listado de la ficha no trae MANUFACTURING_TIME (verificado el 03/11/2026:
  // 0 de 1.490 ofertas de terceros, aunque varios venden a pedido). Sólo cuenta si
  // aparece; si no, el plazo queda sin verificar hasta leerlo en /items/bulk.
  ...(() => { const d = manufacturingDays(o); return d > 0 ? { plazo_dias: d, plazo_fuente: 'products/items' } : { plazo_dias: null, plazo_fuente: null }; })(),
  enlace: `https://articulo.mercadolibre.com.uy/${String(o.item_id ?? o.id).replace(/^MLU/, 'MLU-')}`,
});

async function ofertasDeFicha(ml, pid) {
  const consulta = { fecha: new Date().toISOString(), fuente: `/products/${pid}/items`, alcance: 0, total: null, completa: false, error: null };
  const ofertas = [];
  try {
    let offset = 0;
    for (;;) {
      const page = await ml.get(`/products/${pid}/items?limit=50&offset=${offset}`);
      const rows = Array.isArray(page?.results) ? page.results : [];
      ofertas.push(...rows.map(normOffer));
      consulta.total = Number(page?.paging?.total ?? rows.length);
      offset += rows.length;
      if (!rows.length || offset >= consulta.total || offset >= 200) break;
    }
    consulta.alcance = ofertas.length;
    consulta.completa = consulta.total == null || ofertas.length >= consulta.total;
  } catch (e) { consulta.error = e.code; }
  return { ofertas, consulta };
}

// Plazo de cada oferta por /items/{id}/shipping_options?city_to=<destino>.
// /items/bulk de terceros responde 403 con los dos tokens disponibles
// (verificado el 03/11/2026), así que el plazo sale de las opciones de envío:
//   estimated_delivery_time.schedule — horas de preparación (venta a pedido)
//   estimated_delivery_time.date     — llegada estimada a ESE destino
// La llegada depende del destino: se informa siempre con el destino usado.
export const DESTINO = { city_id: "TUxVQ0NPUjZmZjNm", nombre: "Cordón, Montevideo" };

export function leerEnvio(data) {
  const opts = Array.isArray(data?.options) ? data.options : null;
  if (!opts) return null;
  if (!opts.length) return { plazo_dias: null, llegada: null, sin_envio: true };
  const edts = opts.map(o => o?.estimated_delivery_time).filter(Boolean);
  if (!edts.length) return null;
  const horas = Math.min(...edts.map(e => Number(e.schedule ?? 0)).filter(Number.isFinite));
  const llegada = edts.map(e => e.date).filter(Boolean).sort()[0] ?? null;
  return { plazo_dias: Number.isFinite(horas) ? Math.ceil(horas / 24) : null, llegada, sin_envio: false };
}

// Por ficha, de la oferta más barata a la más cara: alcanza con encontrar una
// sin preparación para saber que hay competencia inmediata. Las ofertas en
// "siempre" (ganadores de la ficha) se consultan igual.
async function verificarPlazos(ml, fichas, siempre = new Set()) {
  const cap = { consultadas: 0, leidas: 0, fallidas: 0, ahorradas: 0, estado: "ok", destino: DESTINO.nombre };
  const una = async o => {
    cap.consultadas++;
    try {
      const env = leerEnvio(await ml.get(`/items/${o.item_id}/shipping_options?city_to=${DESTINO.city_id}`));
      if (!env) { cap.fallidas++; return; }
      cap.leidas++;
      o.plazo_dias = env.plazo_dias; o.llegada = env.llegada; o.sin_envio = env.sin_envio;
      o.plazo_fuente = "shipping_options"; o.destino = DESTINO.nombre;
    } catch { cap.fallidas++; }
  };
  await Promise.all(fichas.map(async ofertas => {
    const orden = [...ofertas].filter(o => /^MLU\d+$/.test(o.item_id)).sort((x, y) => x.precio - y.precio);
    let inmediata = false;
    for (const o of orden) {
      if (o.plazo_fuente === "products/items" && !siempre.has(o.item_id)) continue;
      if (inmediata && !siempre.has(o.item_id)) { cap.ahorradas++; continue; }
      await una(o);
      if (o.plazo_dias === 0 && !o.sin_envio) inmediata = true;
    }
  }));
  if (cap.consultadas && !cap.leidas) cap.estado = "error";
  return cap;
}

export function clasificar(ofertas, propio) {
  // Una oferta verificada como pausada o sin stock no compite hoy.
  const ajenas = ofertas.filter(o => o.vendedor !== SELLER_ID && !(o.plazo_fuente === 'items/bulk' && (o.estado !== 'active' || o.disponible === 0)));
  // Sin envío a ningún destino (shipping_options vacío) no se cuenta como inmediata ni a pedido: queda sin verificar.
  for (const o of ajenas) if (o.sin_envio) o.plazo_dias = null;
  // Mismo libro (ficha de catálogo) y misma condición que la nuestra; usados no compiten con nuevos.
  const comparables = ajenas.filter(o => (propio?.condicion ? o.condicion === propio.condicion : true) && o.internacional !== true && (o.moneda == null || o.moneda === 'UYU'));
  const excluidas = ajenas.length - comparables.length;
  let estado;
  if (!ajenas.length) estado = 'sin_competidores';
  else if (!comparables.length) estado = 'sin_comparables';
  else if (comparables.some(o => o.plazo_dias == null)) estado = comparables.some(o => o.plazo_dias === 0) ? 'con_sin_plazo_declarado' : 'plazo_no_verificado';
  else if (comparables.every(o => o.plazo_dias > 0)) estado = 'solo_con_plazo';
  else estado = 'con_sin_plazo_declarado';
  return { estado, comparables, excluidas, total_ajenas: ajenas.length };
}

// pid → { ofertas, consulta }, con caché por corrida (varias publicaciones propias
// pueden apuntar a la misma ficha).
export async function analizarCompetencia(ml, items, { onProgress = () => {} } = {}) {
  const porProducto = new Map();
  const resultados = new Map();
  const propiosPorPid = new Map();
  for (const it of items) if (it.producto_catalogo) propiosPorPid.set(it.producto_catalogo, [...(propiosPorPid.get(it.producto_catalogo) ?? []), it]);

  // 1. Publicaciones sin ficha pero con ISBN: buscar la ficha por ISBN.
  const sinFicha = items.filter(it => !it.producto_catalogo && it.isbn);
  const busquedas = new Map();
  await Promise.all(sinFicha.map(async it => {
    const consulta = { fecha: new Date().toISOString(), fuente: `/products/search?q=${it.isbn}`, alcance: 0, completa: false, error: null, pid: null, verificado: false };
    try {
      const r = await ml.get(`/products/search?status=active&site_id=${SITE_ID}&q=${it.isbn}&limit=5`);
      const res = Array.isArray(r?.results) ? r.results : [];
      consulta.alcance = res.length; consulta.completa = true;
      // Mismo libro: la ficha tiene que declarar el mismo ISBN (GTIN/ISBN).
      for (const p of res) {
        const gt = (p.attributes ?? []).find(a => ['GTIN', 'ISBN'].includes(a?.id));
        const isbnFicha = normalizeIsbn(gt?.value_name ?? gt?.values?.[0]?.name);
        if (isbnFicha === it.isbn) { consulta.pid = p.id; consulta.verificado = true; break; }
      }
      if (!consulta.pid && res.length === 1) {
        // La búsqueda no trajo atributos: verificar con la ficha completa.
        try {
          const p = await ml.get(`/products/${res[0].id}`);
          const gt = (p.attributes ?? []).find(a => ['GTIN', 'ISBN'].includes(a?.id));
          if (normalizeIsbn(gt?.value_name ?? gt?.values?.[0]?.name) === it.isbn) { consulta.pid = p.id; consulta.verificado = true; }
        } catch (e) { consulta.error = e.code; }
      }
    } catch (e) { consulta.error = e.code; }
    busquedas.set(it.id, consulta);
  }));

  // 2. Ofertas por ficha (propias y encontradas por ISBN).
  const pids = new Set([...propiosPorPid.keys(), ...[...busquedas.values()].map(b => b.pid).filter(Boolean)]);
  let done = 0;
  await Promise.all([...pids].map(async pid => {
    const r = await ofertasDeFicha(ml, pid);
    porProducto.set(pid, r);
    onProgress(++done, pids.size);
  }));

  // 3. price_to_win de nuestras publicaciones de catálogo (una por ficha).
  const ptw = new Map();
  const propiasCatalogo = items.filter(it => it.catalogo && it.producto_catalogo);
  await Promise.all(propiasCatalogo.map(async it => {
    try { ptw.set(it.id, { ok: true, data: await ml.get(`/items/${it.id}/price_to_win?version=v2`) }); }
    catch (e) { ptw.set(it.id, { ok: false, error: e.code }); }
  }));

  // 4. Verificar plazo (y que siga activa con stock) de toda oferta ajena.
  const ganadores = new Set([...ptw.values()].map(p => p.data?.winner?.item_id).filter(Boolean));
  const fichas = [...porProducto.values()].map(r => r.ofertas.filter(o => o.vendedor !== SELLER_ID));
  const capacidadPlazos = await verificarPlazos(ml, fichas, ganadores);
  resultados.capacidadPlazos = capacidadPlazos;

  // 5. Resultado por publicación propia.
  for (const it of items) {
    const b = busquedas.get(it.id);
    const pid = it.producto_catalogo ?? b?.pid ?? null;
    const r = pid ? porProducto.get(pid) : null;
    const base = { item: it, pid, consulta: r?.consulta ?? b ?? { fecha: new Date().toISOString(), fuente: null, completa: false, error: it.isbn ? null : 'sin_isbn' }, busqueda: b ?? null, ptw: ptw.get(it.id) ?? null };
    if (!r || r.consulta.error || !r.consulta.completa) { resultados.set(it.id, { ...base, estado: 'insuficiente', comparables: [], excluidas: 0, total_ajenas: r?.ofertas?.length ?? 0 }); continue; }
    resultados.set(it.id, { ...base, ...clasificar(r.ofertas, it), ofertas: r.ofertas });
  }
  return resultados;
}
