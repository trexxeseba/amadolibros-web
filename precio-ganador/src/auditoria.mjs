// Auditoría independiente de Precio Ganador. Sólo lee: no cambia nada.
//
//   node precio-ganador/src/auditoria.mjs --cuenta libros --estado DIR --salida DIR [--muestra 10]
//
// Escrita aparte del motor a propósito: no importa decision.mjs ni competencia.mjs.
// Vuelve a calcular la regla desde cero y la contrasta con lo que hizo la corrida.
//
//  1. Muestra al azar de N publicaciones de catálogo: relee price_to_win y las
//     ofertas de la ficha, y confirma si de verdad gana o pierde y contra quién.
//  2. Cada publicación del estado (las que el sistema bajó): el precio en ML es
//     el registrado, nunca supera el original, nunca bajó 360 o más ni más del 30 %.
//  3. Cada publicación marcada de la última corrida: la regla recalculada da la
//     misma acción que tomó el motor.
// Cualquier discrepancia hace fallar la auditoría (y el workflow avisa por mail).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from './ml.mjs';
import { idsActivos, detalle } from './publicaciones.mjs';
import { enviarAlarma } from './alarma.mjs';


const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const cuenta = CUENTAS[opt('cuenta')];
if (!cuenta) { console.error('Usar --cuenta libros|vintage'); process.exit(2); }
const UMBRAL = cuenta.umbral ?? 360, TOPE = cuenta.topePct ?? null, MINIMO = cuenta.minimo ?? null;
const INCLUSIVO = cuenta.umbralInclusivo === true, DESCUENTO = cuenta.descuento ?? 0;
const objetivoDe = (g, d = DESCUENTO) => Math.floor(g * (1 - (d || 0)) + 1e-9);
const dirEstado = opt('estado', 'state'), dirSalida = opt('salida', 'salida'), N = Number(opt('muestra', 10));
const leer = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const estado = leer(join(dirEstado, `${cuenta.clave}.json`), { publicaciones: {} }).publicaciones;
const ultima = leer(join(dirSalida, `${cuenta.clave}-filas.json`), []);

export function reglaEsperada(f, { umbral = UMBRAL, inclusivo = INCLUSIVO, descuento = DESCUENTO, tope = TOPE, minimo = MINIMO } = {}) {
  const g = Math.floor(f.ganador + 1e-9), dif = f.precio - g, objetivo = Math.floor(g * (1 - (descuento || 0)) + 1e-9);
  const piso = Number.isFinite(Number(f.piso)) ? Number(f.piso) : minimo;
  if (f.bloqueo) return { esperado: 'saltear', objetivo };
  if (f.moneda !== 'UYU' || f.variaciones) return { esperado: 'saltear', objetivo };
  if ((inclusivo ? dif > umbral : dif >= umbral) || (tope !== null && dif / f.precio > tope)) return { esperado: 'no_tocar', objetivo };
  if (piso !== null && objetivo < piso) return { esperado: 'saltear', objetivo };
  if (f.promo === true || f.promo === null) return { esperado: 'saltear', objetivo };
  return { esperado: 'bajar', objetivo };
}
export function motivosDeFalla({ porTipo, muestraN, erroresAplicar, intentos }) {
  const m = [];
  if (porTipo.muestra > 2) m.push(`${porTipo.muestra} de ${muestraN} de la muestra no coinciden con ML`);
  if (porTipo.regla > 0) m.push(`${porTipo.regla} decisiones no coinciden con la regla`);
  if (porTipo.estado > 10) m.push(`${porTipo.estado} publicaciones del estado con otro precio en ML`);
  if (erroresAplicar > 3 && erroresAplicar > intentos * 0.02) m.push(`${erroresAplicar} errores de aplicación sobre ${intentos} intentos`);
  return m;
}
if (process.env.PRECIO_GANADOR_SOLO_IMPORTAR) { /* tests */ }
const ml = process.env.PRECIO_GANADOR_SOLO_IMPORTAR ? null : crearCliente(fuenteTokenD1(cuenta), { concurrencia: 3 });
const discrepancias = [], muestra = [], controlEstado = [], controlRegla = [];

async function ofertas(pid) {
  try { const d = await ml.get(`/products/${pid}/items?limit=50`); return Array.isArray(d?.results) ? d.results : []; }
  catch (e) { if (e.status === 404) return []; throw e; }
}

async function main() {
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw new Error('token_de_otra_cuenta');

  // 1. Muestra al azar entre las de catálogo.
  const ids = await idsActivos(ml, cuenta.sellerId);
  const items = await detalle(ml, ids);
  const catalogo = [...items.values()].filter(i => i.catalog_listing && i.catalog_product_id);
  for (let i = catalogo.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [catalogo[i], catalogo[j]] = [catalogo[j], catalogo[i]]; }
  for (const it of catalogo.slice(0, N)) {
    const p = await ml.get(`/items/${it.id}/price_to_win?version=v2`);
    const otras = (await ofertas(it.catalog_product_id)).filter(o => String(o.seller_id) !== cuenta.sellerId);
    const masBarata = otras.reduce((m, o) => (m === null || Number(o.price) < m ? Number(o.price) : m), null);
    const ganadorEsMio = p?.winner?.item_id === it.id;
    let conclusion, ok = true;
    if (p?.status === 'winning') {
      conclusion = !ganadorEsMio ? 'ML dice que gana pero el ganador es otra publicación' : masBarata === null ? 'Gana: no hay otros vendedores' : masBarata >= it.price ? `Gana: el competidor más barato está en ${masBarata}` : `Gana aunque hay uno más barato (${masBarata}): ML pesa envío y reputación`;
      ok = ganadorEsMio;
    } else if (p?.status === 'sharing_first_place') conclusion = `Comparte el primer lugar (${p.competitors_sharing_first_place ?? '?'} más)`;
    else if (p?.status === 'competing') {
      const g = Number(p.price_to_win);
      conclusion = `Pierde: para ganar, ${g}. Ganador ${p.winner?.item_id ?? '?'} a ${p.winner?.price ?? '?'}`;
      ok = Number.isFinite(g) ? g <= it.price : true;
    } else conclusion = `Estado ${p?.status ?? 'desconocido'} (no compite)`;
    const oportunidades = (p?.boosts ?? []).filter(b => b.status === 'opportunity').map(b => b.description ?? b.id);
    muestra.push({ id: it.id, titulo: it.title.slice(0, 60), precio: it.price, estado: p?.status, precio_para_ganar: p?.price_to_win ?? null, competidor_mas_barato: masBarata, otras_ofertas: otras.length, sugerencias_ml: oportunidades, conclusion, ok });
    if (!ok) discrepancias.push({ tipo: 'muestra', id: it.id, detalle: conclusion });
  }

  // 2. Las que el sistema bajó: el precio real coincide y respeta los topes.
  const enEstado = Object.entries(estado);
  const actuales = enEstado.length ? await detalle(ml, enEstado.map(([id]) => id)) : new Map();
  for (const [id, e] of enEstado) {
    const real = actuales.get(id)?.price ?? null, orig = Number(e.precio_original), apl = Number(e.precio_aplicado);
    const problemas = [];
    if (real !== apl) problemas.push(`precio en ML ${real}, registrado ${apl}`);
    if (apl > orig) problemas.push('aplicado mayor al original');
    // La baja máxima permitida contra el original: el umbral sobre el ganador y, encima, el descuento.
    const minimoPermitido = objetivoDe(orig - UMBRAL);
    if (INCLUSIVO ? apl < minimoPermitido : apl <= minimoPermitido) problemas.push(`bajó ${orig - apl} (más de lo que permite el umbral ${UMBRAL})`);
    if (TOPE !== null && (orig - apl) / orig > TOPE + 1e-9) problemas.push(`bajó ${Math.round((orig - apl) / orig * 100)} % (más de ${TOPE * 100})`);
    if (MINIMO !== null && apl < MINIMO) problemas.push(`aplicado ${apl} por debajo del mínimo ${MINIMO}`);
    controlEstado.push({ id, titulo: e.titulo, original: orig, aplicado: apl, en_ml: real, ok: !problemas.length, problemas });
    if (problemas.length) discrepancias.push({ tipo: 'estado', id, detalle: problemas.join('; ') });
  }

  // 3. La regla recalculada desde cero para cada marcada nueva de la última corrida.
  for (const f of ultima.filter(f => (f.marcada || f.compite) && !f.en_estado_antes)) {
    const g = Math.floor(f.ganador + 1e-9), dif = f.precio - g;
    const { esperado, objetivo } = reglaEsperada(f);
    const hecho = f.accion === 'bajar' ? 'bajar' : /^sin_tocar/.test(f.accion) ? 'no_tocar' : /^saltear/.test(f.accion) ? 'saltear' : f.accion === 'sin_marcar' ? 'no_tocar' : f.accion;
    const ok = esperado === hecho && (hecho !== 'bajar' || f.precio_nuevo === objetivo);
    controlRegla.push({ id: f.id, precio: f.precio, ganador: f.ganador, diferencia: dif, objetivo, esperado, hecho: f.accion, precio_nuevo: f.precio_nuevo ?? null, ok });
    if (!ok) discrepancias.push({ tipo: 'regla', id: f.id, detalle: `esperado ${esperado}, el motor hizo ${f.accion}` });
  }

  const informe = { fecha: new Date().toISOString(), muestra, control_estado: controlEstado, control_regla: controlRegla, discrepancias, llamadas: ml.stats.llamadas };
  mkdirSync(dirSalida, { recursive: true });
  writeFileSync(join(dirSalida, `${cuenta.clave}-auditoria.json`), JSON.stringify(informe, null, 2));
  writeFileSync(join(dirSalida, `${cuenta.clave}-auditoria.md`), markdown(informe));
  // Errores de aplicación de la corrida (de las filas que dejó run.mjs).
  const erroresAplicar = ultima.filter(f => f.accion === 'error_aplicar').length;
  const intentos = ultima.filter(f => f.accion === 'error_aplicar' || f.aplicado === true).length;
  const porTipo = { muestra: 0, estado: 0, regla: 0 };
  for (const d of discrepancias) porTipo[d.tipo]++;
  // El job falla sólo si el problema es serio: más de 2 de la muestra de 10, una
  // discrepancia de regla (es un bug), más de 10 publicaciones del estado con otro
  // precio, o errores de aplicación por encima del 2 % de los intentos (mínimo 3).
  const motivosFalla = motivosDeFalla({ porTipo, muestraN: muestra.length, erroresAplicar, intentos });
  console.log(JSON.stringify({ muestra: muestra.length, estado: controlEstado.length, regla: controlRegla.length, discrepancias: discrepancias.length, por_tipo: porTipo, errores_aplicar: erroresAplicar, falla: motivosFalla }));
  // Cualquier discrepancia se avisa por mail con los IDs; el job queda en verde si no es seria.
  if (discrepancias.length || erroresAplicar) {
    const lineas = discrepancias.map(d => `- ${d.id} (${d.tipo}): ${d.detalle}`).join('\n');
    const errores = ultima.filter(f => f.accion === 'error_aplicar').map(f => `- ${f.id}: ${f.motivo ?? 'error'}`).join('\n');
    await enviarAlarma({
      aviso: !motivosFalla.length,
      asunto: motivosFalla.length ? `auditoría de ${cuenta.nombre} con problemas serios` : `auditoría de ${cuenta.nombre} con avisos (la corrida está bien)`,
      texto: `${motivosFalla.length ? 'La auditoría FALLÓ: ' + motivosFalla.join('; ') + '.' : 'La corrida terminó bien. La auditoría encontró avisos que no la tumban.'}\n\nDiscrepancias (${discrepancias.length}):\n${lineas || '- ninguna'}\n\nErrores de aplicación (${erroresAplicar}):\n${errores || '- ninguno'}`,
    });
  }
  if (motivosFalla.length) process.exit(1);
}

function markdown(i) {
  const l = [`# Auditoría Precio Ganador · ${cuenta.nombre} · ${i.fecha}`, '', `Discrepancias: **${i.discrepancias.length}**`, '',
    `## ${i.muestra.length} publicaciones de catálogo al azar`, '', '| Publicación | Precio | Estado ML | Para ganar | Competidor más barato | Sugerencias de ML | Conclusión | OK |', '|---|---:|---|---:|---:|---|---|---|'];
  for (const m of i.muestra) l.push(`| ${m.id} ${m.titulo.replace(/\|/g, '/')} | ${m.precio} | ${m.estado} | ${m.precio_para_ganar ?? ''} | ${m.competidor_mas_barato ?? 'ninguno'} | ${m.sugerencias_ml.join(', ')} | ${m.conclusion} | ${m.ok ? 'sí' : 'NO'} |`);
  l.push('', `## Publicaciones que el sistema bajó (${i.control_estado.length})`, '', '| Publicación | Original | Registrado | En ML hoy | OK |', '|---|---:|---:|---:|---|');
  for (const c of i.control_estado) l.push(`| ${c.id} ${String(c.titulo ?? '').slice(0, 50).replace(/\|/g, '/')} | ${c.original} | ${c.aplicado} | ${c.en_ml} | ${c.ok ? 'sí' : 'NO: ' + c.problemas.join('; ')} |`);
  l.push('', `## Regla recalculada sobre las marcadas de la última corrida (${i.control_regla.length})`, '', '| Publicación | Precio | Ganador | Diferencia | Esperado | Hizo | OK |', '|---|---:|---:|---:|---|---|---|');
  for (const c of i.control_regla) l.push(`| ${c.id} | ${c.precio} | ${c.ganador} | ${c.diferencia} | ${c.esperado} | ${c.hecho}${c.precio_nuevo ? ' → ' + c.precio_nuevo : ''} | ${c.ok ? 'sí' : 'NO'} |`);
  return l.join('\n') + '\n';
}

if (!process.env.PRECIO_GANADOR_SOLO_IMPORTAR) main().catch(e => { console.error('Auditoría fallida:', e?.code ?? e?.message ?? 'error'); process.exit(1); });
