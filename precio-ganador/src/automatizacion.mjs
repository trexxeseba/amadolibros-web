// Automatización de precios de Mercado Libre para Amado Libros (pedido de Seba, 25/11/2026).
// Mercado Libre ajusta solo el precio para ganar, entre un mínimo y un máximo que fija el vendedor.
//
//   node precio-ganador/src/automatizacion.mjs --cuenta libros --accion leer    --salida DIR [--grupo tarot_oraculos]
//   node precio-ganador/src/automatizacion.mjs --cuenta libros --accion aplicar --salida DIR [--grupo tarot_oraculos] [--tope 40] [--real]
//   node precio-ganador/src/automatizacion.mjs --cuenta libros --accion quitar  --salida DIR --ids MLU1,MLU2 [--real]
//
// leer: qué reglas admite cada publicación del grupo y si ya tiene una puesta. Sólo GET.
// aplicar: a las que admiten regla y no tienen automatización, les pone la regla con mínimo y máximo.
//   Mínimo provisorio = 60 % del precio de lista (Seba no tiene los costos cargados: no se inventan);
//   máximo = precio de lista + 45 % (para subir cuando no hay competencia). Sin --real sólo lista lo que haría.
// quitar: saca la automatización de las publicaciones indicadas (deshacer).
// revisar: para las que tienen automatización, por qué está pausada: respuesta completa de la automatización,
//   promociones en las que está (/seller-promotions/items) y precio para ganar. Sólo GET (Seba 27/11/2026).
// corregir_minimos: a las que tienen un mínimo distinto de la regla de Seba (mayor entre $500 y 60 % del precio
//   de lista), les pone mínimo y máximo de la regla, sin cambiar la regla de ML que ya tienen. Sin --real sólo lista.
// Cada cambio queda en el registro (archivo de salida, repo privado) con el estado anterior. El log sólo
// lleva conteos y códigos (el repo es público).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from '../../agentes-ml/src/ml.mjs';
import { idsActivos, detalle } from './publicaciones.mjs';
import { grupoDe } from './dormidas.mjs';

// Seba 26/11/2026 (decisión C): piso de $500 en libros y máximo = precio base (vuelve al base cuando no hay
// competencia o la competencia sube). El mínimo sigue en 60 % del precio de lista, nunca debajo de $500.
export const MINIMO_PCT = 0.60, MAXIMO_PCT = 1.00, PISO = 500;
// Preferencia de regla: competir contra Mercado Libre y afuera si se ofrece; si no, sólo dentro de Mercado Libre.
export const PREFERENCIA = ['INT_EXT', 'INT'];

// Mínimo y máximo a partir del precio de lista. Función pura.
export function limites(precioLista, { minimoPct = MINIMO_PCT, maximoPct = MAXIMO_PCT, piso = PISO } = {}) {
  const p = Number(precioLista);
  if (!(p > 0)) return null;
  const min_price = Math.max(piso, Math.ceil(p * minimoPct)), max_price = Math.floor(p * maximoPct);
  return min_price < max_price ? { min_price, max_price } : null;
}

// Comparación (Seba 26/11): qué precio dejaría la automatización de ML y qué haría la regla de Precio Ganador.
// ML: el precio para ganar, dentro de mínimo y máximo; sin competencia, el máximo (precio base).
// Precio Ganador: si el ganador está a menos de $400, 0,99 x ganador (nunca debajo de $500); sin competencia,
// vuelve al precio base; si la diferencia es de $400 o más, no toca. Función pura.
export function compararRegla({ precio, lista, estado, ganador, piso = PISO, umbral = 400 }) {
  const lim = limites(lista);
  const compite = estado === 'competing' && Number(ganador) > 0 && Number(ganador) < precio;
  const ml = !lim ? null : compite ? Math.min(lim.max_price, Math.max(lim.min_price, Math.floor(Number(ganador)))) : lim.max_price;
  let pg;
  if (!compite) pg = Math.floor(lista);
  else if (precio - Number(ganador) < umbral) pg = Math.max(piso, Math.floor(Number(ganador) * 0.99));
  else pg = precio;
  return { compite, ml, pg, diferencia: ml === null ? null : ml - pg };
}

// Saca los números de publicación de un texto antes de ir al log público. Función pura.
export const sinIds = v => v === null ? null : JSON.parse(JSON.stringify(v).replace(/MLUd+/g, 'MLU…'));

// El mínimo puesto en ML coincide con la regla de Seba. Función pura.
export function minimoOk(fila) {
  const lim = limites(fila?.precio_lista);
  return !!lim && Number(fila?.automatizacion_antes?.min_price) === lim.min_price;
}

// Regla a usar entre las que admite la publicación. Función pura.
export function elegirRegla(reglas) {
  const ids = (Array.isArray(reglas) ? reglas : []).map(r => String(r?.rule_id ?? r?.id ?? r ?? '')).filter(Boolean);
  return PREFERENCIA.find(r => ids.includes(r)) ?? null;
}

// Candidata a automatizar: activa, en pesos, sin variaciones, con stock, admite regla y no tiene una puesta. Función pura.
export function esAutomatizable(fila) {
  return !!fila && fila.estado === 'active' && fila.moneda === 'UYU' && !fila.variaciones && fila.stock >= 1 && !!fila.regla_elegida && !fila.automatizada;
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
  const accion = opt('accion', 'leer'), grupo = opt('grupo', 'todos'), tope = Number(opt('tope', 40)), real = args.includes('--real'), salida = opt('salida', '.');
  const idsPedidos = String(opt('ids', '')).split(/[,\s]+/).filter(id => /^MLU\d+$/.test(id));
  if (!['leer', 'aplicar', 'quitar', 'comparar', 'revisar', 'corregir_minimos'].includes(accion)) { console.error('accion: leer | aplicar | quitar | comparar | revisar | corregir_minimos'); process.exit(2); }
  const escribe = real && !['leer', 'comparar', 'revisar'].includes(accion);
  const ml = crearCliente(fuenteTokenD1(cuenta), { intentos: 4, concurrencia: 4, soloLectura: !escribe });
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });

  const todos = [...(await detalle(ml, await idsActivos(ml, cuenta.sellerId))).values()];
  const elegidos = accion === 'quitar' ? todos.filter(i => idsPedidos.includes(i.id)) : todos.filter(i => i.status === 'active' && (grupo === 'todos' || grupoDe(i.title) === grupo));
  const filas = []; const http = { reglas: {}, automatizacion: {} };
  await enParalelo(elegidos, 4, async it => {
    const r = await ml.sonda(`/pricing-automation/items/${it.id}/rules`);
    const a = await ml.sonda(`/pricing-automation/items/${it.id}/automation`);
    http.reglas[r.status] = (http.reglas[r.status] ?? 0) + 1; http.automatizacion[a.status] = (http.automatizacion[a.status] ?? 0) + 1;
    const reglas = r.ok ? (r.json?.rules ?? []).map(x => String(x?.rule_id ?? x?.id ?? '')).filter(Boolean) : [];
    // Precio de lista: el regular si hay una promoción a la vista; si no, el precio.
    const lista = Number(it.original_price) > 0 ? Number(it.original_price) : Number(it.price);
    filas.push({ id: it.id, titulo: String(it.title ?? '').slice(0, 80), precio: Number(it.price), precio_lista: lista, stock: Number(it.available_quantity), catalogo: !!it.catalog_listing,
      estado: it.status, moneda: it.currency_id, variaciones: !!it.variaciones, reglas, regla_elegida: elegirRegla(reglas), automatizada: a.ok,
      deal_ids: it.deal_ids ?? [], automatizacion_cruda: accion === 'revisar' && a.ok ? a.json : undefined,
      automatizacion_antes: a.ok ? { status: a.json?.status ?? null, rule_id: a.json?.item_rule?.rule_id ?? a.json?.rule_id ?? null, min_price: a.json?.min_price ?? null, max_price: a.json?.max_price ?? null } : null });
  });

  const cambios = []; const resultado = {};
  let comparacion = null;
  if (accion === 'comparar') {
    // 10 que compiten sin ganar y 3 que ganan solas (vuelta al precio base), de las que admiten regla.
    const { entregaDe } = await import('./competencia.mjs');
    const cache = new Map(); const compiten = [], solas = [];
    for (const f of filas.filter(esAutomatizable).sort((a, b) => b.stock - a.stock)) {
      if (compiten.length >= 10 && solas.length >= 3) break;
      const p = await ml.sonda(`/items/${f.id}/price_to_win?version=v2`);
      if (!p.ok) continue;
      const estado = String(p.json?.status ?? ''), ganador = Number(p.json?.price_to_win) || null;
      const c = compararRegla({ precio: f.precio, lista: f.precio_lista, estado, ganador });
      const fila = { id: f.id, titulo: f.titulo, precio: f.precio, precio_lista: f.precio_lista, estado_ml: estado, ganador, ...c, limites: limites(f.precio_lista) };
      if (c.compite && compiten.length < 10) { fila.entrega_ganador = await entregaDe(ml, p.json?.winner?.item_id, cache); compiten.push(fila); }
      else if (!c.compite && estado === 'winning' && f.precio < f.precio_lista && solas.length < 3) solas.push(fila);
    }
    comparacion = { compiten, solas };
    resultado.comparadas = compiten.length + solas.length;
    resultado.ml_mas_bajo_que_pg = compiten.filter(x => x.diferencia < 0).length;
    resultado.ganador_a_pedido = compiten.filter(x => x.entrega_ganador === 'demanda').length;
  }
  const anotar = k => { resultado[k] = (resultado[k] ?? 0) + 1; };
  let revision = null;
  if (accion === 'revisar') {
    revision = [];
    await enParalelo(filas.filter(f => f.automatizada), 3, async f => {
      const pr = await ml.sonda(`/seller-promotions/items/${f.id}?app_version=v2`);
      const pw = await ml.sonda(`/items/${f.id}/price_to_win?version=v2`);
      const promos = pr.ok && Array.isArray(pr.json) ? pr.json.map(x => ({ id: x?.id ?? null, tipo: x?.type ?? null, estado: x?.status ?? null, inicio: x?.start_date ?? null, fin: x?.finish_date ?? null, precio: x?.price ?? null })) : null;
      const r = { id: f.id, estado_auto: f.automatizacion_antes?.status ?? null, minimo_ok: minimoOk(f), promos_http: pr.status, promos, en_promo_activa: !!promos?.some(x => x.estado === 'started'),
        en_promo_futura: !!promos?.some(x => ['pending', 'candidate'].includes(String(x.estado))), ptw_http: pw.status, ptw_estado: pw.ok ? pw.json?.status ?? null : null, ptw_precio: pw.ok ? pw.json?.price_to_win ?? null : null,
        precio: f.precio, precio_lista: f.precio_lista, cruda: f.automatizacion_cruda };
      revision.push(r);
      anotar(`${r.estado_auto}|promo_activa:${r.en_promo_activa}|ptw:${r.ptw_estado ?? 'http_' + r.ptw_http}`);
    });
    // Campos de la respuesta de automatización que podrían explicar la pausa (nombres, no valores).
    const campos = {}; for (const r of revision) for (const k of Object.keys(r.cruda ?? {})) campos[k] = (campos[k] ?? 0) + 1;
    resultado.campos_automatizacion = campos;
  }
  if (accion === 'corregir_minimos') {
    for (const f of filas.filter(x => x.automatizada && !minimoOk(x))) {
      const lim = limites(f.precio_lista);
      if (!lim || lim.min_price >= f.precio) { anotar('salteada_minimo_sobre_el_precio'); continue; }
      const body = { rule_id: f.automatizacion_antes.rule_id ?? f.regla_elegida, ...lim };
      const cambio = { id: f.id, titulo: f.titulo, precio_antes: f.precio, precio_lista: f.precio_lista, antes: f.automatizacion_antes, pedido: body, fecha: new Date().toISOString() };
      if (!escribe) { anotar('haria'); cambios.push({ ...cambio, estado: 'haria' }); continue; }
      try { await ml.put(`/pricing-automation/items/${f.id}/automation`, body); }
      catch (e) { anotar('error_http_' + (e?.status ?? 0)); cambios.push({ ...cambio, estado: 'error', error: { http: e?.status ?? 0, detalle: e?.detalle ?? null } }); if (e?.status === 429) throw e; continue; }
      const despues = await ml.sonda(`/pricing-automation/items/${f.id}/automation`);
      const ok = despues.ok && Number(despues.json?.min_price) === lim.min_price;
      anotar(ok ? 'corregida' : 'sin_verificar');
      cambios.push({ ...cambio, estado: ok ? 'corregida' : 'sin_verificar', despues: despues.ok ? { status: despues.json?.status ?? null, min_price: despues.json?.min_price ?? null, max_price: despues.json?.max_price ?? null } : { http: despues.status } });
    }
  }
  if (accion === 'aplicar') {
    const candidatas = filas.filter(esAutomatizable).sort((a, b) => b.stock - a.stock).slice(0, tope);
    for (const f of candidatas) {
      const lim = limites(f.precio_lista);
      if (!lim || lim.min_price >= f.precio) { anotar('salteada_minimo_sobre_el_precio'); continue; }
      const body = { rule_id: f.regla_elegida, ...lim };
      const cambio = { id: f.id, titulo: f.titulo, precio_antes: f.precio, precio_lista: f.precio_lista, antes: null, pedido: body, fecha: new Date().toISOString() };
      if (!escribe) { anotar('haria'); cambios.push({ ...cambio, estado: 'haria' }); continue; }
      let r; try { r = await ml.post(`/pricing-automation/items/${f.id}/automation`, body); }
      catch (e) { anotar('error_http_' + (e?.status ?? 0)); cambios.push({ ...cambio, estado: 'error', error: { http: e?.status ?? 0, detalle: e?.detalle ?? null } }); if (e?.status === 429) throw e; continue; }
      const despues = await ml.sonda(`/pricing-automation/items/${f.id}/automation`);
      const ok = despues.ok && Number(despues.json?.min_price) === lim.min_price;
      anotar(ok ? 'automatizada' : 'sin_verificar');
      cambios.push({ ...cambio, estado: ok ? 'automatizada' : 'sin_verificar', respuesta: { status: r?.status ?? null }, despues: despues.ok ? { status: despues.json?.status ?? null, min_price: despues.json?.min_price ?? null, max_price: despues.json?.max_price ?? null } : { http: despues.status } });
    }
  }
  if (accion === 'quitar') {
    for (const f of filas.filter(x => x.automatizada)) {
      const cambio = { id: f.id, titulo: f.titulo, antes: f.automatizacion_antes, fecha: new Date().toISOString() };
      if (!escribe) { anotar('quitaria'); cambios.push({ ...cambio, estado: 'quitaria' }); continue; }
      try { await ml.delete(`/pricing-automation/items/${f.id}/automation`); anotar('quitada'); cambios.push({ ...cambio, estado: 'quitada' }); }
      catch (e) { anotar('error_http_' + (e?.status ?? 0)); cambios.push({ ...cambio, estado: 'error', error: { http: e?.status ?? 0, detalle: e?.detalle ?? null } }); }
    }
  }
  const porRegla = {}; for (const f of filas) { const k = f.regla_elegida ?? 'sin_regla'; porRegla[k] = (porRegla[k] ?? 0) + 1; }
  const resumen = { fecha: new Date().toISOString().slice(0, 10), cuenta: cuenta.clave, accion, grupo: accion === 'quitar' ? null : grupo, modo: escribe ? 'real' : 'prueba', publicaciones: filas.length, http,
    por_regla: porRegla, ya_automatizadas: filas.filter(f => f.automatizada).length, minimo_distinto: filas.filter(f => f.automatizada && !minimoOk(f)).length, automatizables: filas.filter(esAutomatizable).length, resultado,
    ejemplo_error: sinIds(cambios.find(c => c.estado === 'error')?.error ?? null) };
  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, `${cuenta.clave}-automatizacion-${accion}.json`), JSON.stringify({ resumen, filas: accion === 'comparar' ? undefined : filas, cambios, comparacion, revision }, null, 1));
  console.log(JSON.stringify(resumen)); // sólo conteos y códigos: el log es público
  if (Object.keys(resultado).some(k => k.startsWith('error') || k === 'sin_verificar')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('automatizacion:', e?.code ?? e?.message); process.exit(1); });
