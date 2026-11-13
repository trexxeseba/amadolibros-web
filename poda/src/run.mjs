// Poda diaria de anuncios de Mercado Ads (Amado Libros). Corre en GitHub Actions.
//
//   node poda/src/run.mjs --accion correr|auditar|restaurar [--prueba]
//
// Mercado Libre NO documenta cambiar el estado de un anuncio por API: este proceso
// sólo LEE (el cliente rechaza cualquier método que no sea GET). Calcula con las reglas
// del 11/11/2026 qué pausar y qué reactivar, lo deja en el registro de D1 y en la fila
// diaria de la mesa, y el Agente único lo ejecuta por navegador sin calcular nada.
//
// El repo y sus logs son públicos: por stdout sólo salen cantidades. Montos, títulos y
// precios van a D1 (poda_corridas, poda_registro) y a la mesa.
//
// Frenos: si cualquier lectura clave falla (token, métricas, órdenes, precios) la
// corrida no escribe nada y deja una fila de Error. Sin órdenes legibles y frescas no
// se propone ninguna pausa. Máximo 25 pausas por corrida y 60 por día.
import { readFileSync } from 'node:fs';
import { CUENTA, fechaMontevideo, fechaCorrida } from '../../agentes-ml/src/config.mjs';
import { crearCliente } from '../../agentes-ml/src/ml.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';
import { crearD1, lit, ESQUEMA, grabarCambios } from './d1.mjs';
import { calcularDia } from './estado.mjs';
import { REGLAS } from './reglas.mjs';
import { armarFilaDiaria, armarFilaAlerta, subirFila, enviarMail } from './mesa.mjs';

const json = nombre => JSON.parse(readFileSync(new URL(`../${nombre}`, import.meta.url), 'utf8'));
const ADVERTISER_ID = 51659;            // anunciante de Amado Libros en Mercado Ads (consola de Ads)
const SITE = 'MLU';
const CAMPANIA_FANTASMA = '301999953';  // donde ML deja los anuncios sin campaña: no existe como campaña
const H = { headers: { 'Api-Version': '2' } };
const METRICAS = 'CLICKS,COST,CPC,UNITS_QUANTITY,DIRECT_UNITS_QUANTITY,INDIRECT_UNITS_QUANTITY';
const FRESCURA_ORDENES_MS = 6 * 3600 * 1000;
const num = v => (v === null || v === undefined || !Number.isFinite(Number(v))) ? 0 : Number(v);

export function leerArgs(argv) {
  const o = { accion: 'correr', prueba: false };
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--accion') o.accion = argv[++i]; else if (argv[i] === '--prueba') o.prueba = true; }
  return o;
}

// Modo efectivo: real sólo si el archivo lo dice, la variable no lo frena y no es una prueba.
export function modoEfectivo({ archivo, varDryRun, prueba }) {
  const m = String(archivo ?? 'dry-run').toLowerCase();
  if (m === 'off') return { modo: 'off', real: false };
  return { modo: m === 'real' ? 'real' : 'dry-run', real: m === 'real' && String(varDryRun ?? '').toLowerCase() !== 'true' && !prueba };
}

export function grupoDeMetricas(g, campanias, hoy, cfg) {
  const m = g.metrics ?? {};
  const camp = campanias.get(String(g.campaign_id));
  const itemSinPoda = cfg.items_sin_poda ?? {};
  let estado = String(g.status ?? '').toUpperCase();
  if (estado === 'ACTIVE' && camp && camp.status !== 'active') estado = 'CAMPANA_PAUSADA';
  const protegido = cfg.campanas?.map(String).includes(String(g.campaign_id)) ? 'Campaña protegida.' : null;
  return {
    id: String(g.id), external_id: g.ad_group_external_id ?? null, tipo: g.ad_group_type ?? null, titulo: g.title ?? null,
    item_ids: g.ad_group_type === 'ITEM' && g.ad_group_external_id ? [g.ad_group_external_id] : [],
    campaign_id: g.campaign_id != null ? String(g.campaign_id) : null, campaign_nombre: camp?.name ?? null, estado, protegido,
    gasto: num(m.cost), clics: num(m.clicks), cpc: num(m.cpc) || null,
    ventasAtribuidas: num(m.units_quantity) || (num(m.direct_units_quantity) + num(m.indirect_units_quantity)),
    ventasOrdenes: 0, precio: null, precioTope: null, promo: false, salteado: true, _sinPoda: itemSinPoda, _hoy: hoy,
  };
}

async function main() {
  const { accion, prueba } = leerArgs(process.argv.slice(2));
  const hoy = fechaMontevideo(), env = process.env;
  const { modo, real } = modoEfectivo({ archivo: json('modo.json').modo, varDryRun: env.PODA_DRY_RUN, prueba });
  if (modo === 'off') { console.log('Poda: modo off, no se hace nada.'); return; }
  if (!['correr', 'auditar', 'restaurar'].includes(accion)) { console.error('Acción desconocida.'); process.exit(2); }
  const d1 = crearD1();
  const cfg = json('protegidas.json'), semillasArchivo = json('semillas.json');
  const t0 = Date.now();
  const contadoresError = { errores: 0 };
  try {
    const ml = crearCliente(fuenteTokenD1(CUENTA), { intentos: 4, concurrencia: 4 });   // sólo lectura
    for (const s of ESQUEMA) await d1.query(s);
    const yo = await ml.get('/users/me');
    if (String(yo?.id) !== CUENTA.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { code: 'token_de_otra_cuenta', fatal: true });

    // ── Órdenes de los últimos 30 días (D1, las mantiene el Worker). Si no están frescas, no se pausa nada.
    const desdeMs = Date.now() - REGLAS.diasVentana * 86400000;
    const [{ m: ultimaSync } = {}] = await d1.query('SELECT MAX(fetched_at) AS m FROM ml_sales_orders');
    const ordenesLegibles = Number.isFinite(Number(ultimaSync)) && Date.now() - Number(ultimaSync) < FRESCURA_ORDENES_MS;
    const filasOrdenes = ordenesLegibles ? await d1.query(`SELECT i.item_id AS item_id, o.date_created_ms AS ms FROM ml_sales_items i JOIN ml_sales_orders o ON o.order_id = i.order_id WHERE o.date_created_ms >= ${desdeMs} AND o.status != 'cancelled'`) : [];
    const ordenesPorItem = new Map();
    for (const f of filasOrdenes) { const a = ordenesPorItem.get(f.item_id) ?? []; a.push(Number(f.ms)); ordenesPorItem.set(f.item_id, a); }

    // ── Campañas y grupos de anuncios con métricas de 30 días.
    const desde = fechaCorrida(-REGLAS.diasVentana), base = `/advertising/${SITE}/advertisers/${ADVERTISER_ID}/product_ads`;
    const campanias = new Map();
    for (let off = 0; ; off += 50) {
      const r = await ml.get(`${base}/campaigns/search?limit=50&offset=${off}`, H);
      for (const c of r?.results ?? []) campanias.set(String(c.id), { id: String(c.id), name: c.name ?? null, status: String(c.status ?? '').toLowerCase() });
      if ((r?.results ?? []).length < 50 || off >= 500) break;
    }
    const grupos = new Map();
    for (const c of campanias.values()) {
      if (c.id === CAMPANIA_FANTASMA) continue;
      for (let off = 0; off < 10000; off += 50) {
        const r = await ml.get(`${base}/ad_groups/search?limit=50&offset=${off}&date_from=${desde}&date_to=${hoy}&metrics=${METRICAS}&filters[campaign_id]=${c.id}`, H);
        for (const g of r?.results ?? []) grupos.set(String(g.id), grupoDeMetricas(g, campanias, hoy, cfg));
        if ((r?.results ?? []).length < 50) break;
      }
    }
    if (!grupos.size) throw Object.assign(new Error('sin_anuncios_leidos'), { code: 'sin_anuncios_leidos', fatal: true });

    // ── Registro de la poda y semillas.
    const registro = await d1.query('SELECT * FROM poda_registro');
    const semillas = [];
    for (const s of semillasArchivo) {
      const r = await ml.get(`${base}/ad_groups/search?filters[item_ids]=${s.item_id}`, H);
      const g = r?.results?.[0];
      if (!g) continue;
      if (!grupos.has(String(g.id))) grupos.set(String(g.id), grupoDeMetricas(g, campanias, hoy, cfg));
      semillas.push({ ...s, external_id: g.ad_group_external_id });
    }

    // ── Lectura a fondo sólo de los candidatos, los del registro y las semillas.
    const ids = new Set(registro.map(r => String(r.ad_group_id)));
    for (const s of semillas) for (const g of grupos.values()) if (g.external_id === s.external_id) ids.add(g.id);
    for (const g of grupos.values()) if (g.estado === 'ACTIVE' && g.clics >= REGLAS.minClics && g.ventasAtribuidas === 0 && g.gasto >= REGLAS.pisoTope * REGLAS.pctObservacion) ids.add(g.id);
    let leidos = 0, fallidos = 0;
    for (const id of ids) {
      const g = grupos.get(id);
      if (!g) continue;
      g.salteado = false; leidos++;
      try {
        if (!g.item_ids.length) {
          const a = await ml.get(`/advertising/${SITE}/product_ads/ad_groups/${id}/ads?date_from=${desde}&date_to=${hoy}&metrics=clicks`, H);
          g.item_ids = (a?.results ?? []).map(x => x.item_id).filter(Boolean);
        }
        const precios = [];
        for (const it of g.item_ids.slice(0, 10)) {
          const sp = await ml.sonda(`/items/${it}/sale_price`);
          if (sp.ok && Number(sp.json?.amount) > 0) precios.push({ amount: Number(sp.json.amount), regular: Number(sp.json.regular_amount) > 0 ? Number(sp.json.regular_amount) : null });
        }
        if (precios.length) {
          g.precio = Math.max(...precios.map(p => p.amount)); g.precioTope = Math.max(...precios.map(p => p.regular ?? p.amount));
          g.promo = precios.some(p => p.regular && p.regular > p.amount);
        } else fallidos++;
        const lista = g.item_ids.flatMap(it => ordenesPorItem.get(it) ?? []);
        g.ventasOrdenes = lista.length;
        g.ordenesDesde = fecha => lista.filter(ms => ms >= Date.parse(fecha + 'T00:00:00-03:00')).length;
        const reg = registro.find(r => String(r.ad_group_id) === id);
        if (reg?.estado === 'contando' && reg.contar_desde) {
          const m = (await ml.get(`/advertising/${SITE}/product_ads/ad_groups/${id}?date_from=${reg.contar_desde}&date_to=${hoy}&metrics=${METRICAS}`, H))?.metrics ?? {};
          g.gasto = num(m.cost); g.clics = num(m.clicks); g.cpc = num(m.cpc) || null; g.ventasAtribuidas = num(m.units_quantity);
        }
        const protegidoItem = g.item_ids.find(it => g._sinPoda[it] && g._sinPoda[it] >= hoy);
        if (protegidoItem) g.protegido = `Sin poda hasta ${g._sinPoda[protegidoItem]} (tuvo venta).`;
      } catch (e) { if (e?.fatal) throw e; fallidos++; g.salteado = true; }
    }
    if (leidos >= 5 && fallidos / leidos > 0.2) throw Object.assign(new Error('lecturas_fallidas_de_precio_u_orden'), { code: 'lecturas_fallidas' });
    contadoresError.errores = fallidos;

    // ── Cálculo. Sin órdenes frescas no se propone ninguna pausa (regla 4).
    let accionCalculo = accion === 'restaurar' ? 'auditar' : accion;
    if (!ordenesLegibles && accionCalculo === 'correr') accionCalculo = 'auditar';
    const resultado = calcularDia({ hoy, accion: accionCalculo, grupos, registro, semillas });
    if (accion === 'restaurar') {
      for (const r of registro.filter(x => x.estado === 'pausado' && x.origen === 'poda')) {
        const g = grupos.get(String(r.ad_group_id)); if (!g) continue;
        resultado.cambios.push({ tipo: 'upsert', fila: { ...r, estado: 'propuesta_reactivar', regla_reactivar: 0, motivo: 'Restaurar: reactivar todo lo que pausó la poda.', fecha_reactivar_propuesta: hoy, actualizado: hoy } });
        resultado.listas.reactivar.push({ ad_group_id: r.ad_group_id, titulo: r.titulo, item_ids: JSON.parse(r.item_ids_json ?? '[]'), precio_lista: r.precio_lista, gasto: r.gasto, clics: r.clics, cpc: r.cpc, motivo: 'Restaurar.' });
      }
      resultado.contadores.reactivar = resultado.listas.reactivar.length;
    }
    resultado.contadores.errores = contadoresError.errores;
    resultado.contadores.ordenes_frescas = ordenesLegibles;
    if (resultado.alertaFreno) resultado.contadores.alerta_freno = true;

    // ── Escrituras de la nube: registro en D1 (sólo en modo real) y detalle de la corrida (siempre).
    let registroGrabado = 0;
    if (real) registroGrabado = await grabarCambios(d1, resultado.cambios);
    const detalle = { listas: resultado.listas, contadores: resultado.contadores };
    await d1.query(`INSERT INTO poda_corridas(fecha, accion, modo, contadores_json, detalle_json, creado_ms) VALUES(${lit(hoy)}, ${lit(accion)}, ${lit(modo + (real ? '' : '/sin-registro'))}, ${lit(JSON.stringify(resultado.contadores))}, ${lit(JSON.stringify(detalle).slice(0, 900000))}, ${Date.now()});`);

    // ── Mesa (o mail de respaldo, privado). Una fila por día; si existe se actualiza.
    const fila = armarFilaDiaria({ fecha: hoy, accion: accion === 'restaurar' ? 'auditar' : accion, modo, real, resultado });
    let mesa = await subirFila(fila);
    if (resultado.alertaFreno) await subirFila(armarFilaAlerta({ fecha: hoy, motivo: 'freno', detalle: `El cálculo pidió más pausas que el máximo por corrida (${REGLAS.maxPorCorrida}) o por día (${REGLAS.maxPorDia}). Los excedentes no se propusieron. Puede ser un error en los datos: revisar.` }));
    if (!ordenesLegibles && accion === 'correr') await subirFila(armarFilaAlerta({ fecha: hoy, motivo: 'ordenes', detalle: 'Las órdenes de la tienda no están frescas en la base: no se propuso ninguna pausa en esta corrida.' }));
    let mail = null;
    if (!mesa.ok) mail = await enviarMail({ asunto: `Poda de anuncios ${hoy} (${real ? 'real' : 'prueba'})`, texto: fila.fldwtSvMycZShRfJD ?? Object.values(fila).join('\n'), env });

    const c = resultado.contadores;
    console.log(`Poda ${accion} ${modo}${real ? '' : ' (no registra)'}: evaluados ${c.evaluados}, a pausar ${c.pausar + c.pausaria}, pendientes ${c.pendientes_pausa}, a reactivar ${c.reactivar}, observación ${c.observacion}, clic caro ${c.clic_caro}, falta precio ${c.falta_precio}, excedentes ${c.excedentes}, errores ${c.errores}. Registro: ${registroGrabado} cambios. Mesa: ${mesa.ok ? 'ok' : mesa.motivo}${mail ? `, mail: ${mail.ok ? 'ok' : mail.motivo}` : ''}. ${Math.round((Date.now() - t0) / 1000)} s.`);
  } catch (e) {
    // Nada se escribió en el registro. Se deja la fila de Error y se falla el job.
    const motivo = String(e?.code ?? e?.message ?? 'error').replace(/[^\w.:-]/g, '').slice(0, 80);
    const detalleError = `La corrida ${accion} no escribió nada. Error observado: ${motivo}${e?.status ? ` (HTTP ${e.status})` : ''}${e?.path ? ` en ${String(e.path).split('?')[0]}` : ''}${e?.detalle?.message ? `, ${String(e.detalle.message).slice(0, 120)}` : ''}.`;
    const r = await subirFila(armarFilaAlerta({ fecha: hoy, motivo: 'error', detalle: detalleError })).catch(() => ({ ok: false }));
    if (!r.ok) await enviarMail({ asunto: `Poda de anuncios ${hoy}: ERROR`, texto: detalleError, env }).catch(() => {});
    console.error(`Poda fallida: ${motivo}${e?.status ? ` HTTP ${e.status}` : ''}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main();
