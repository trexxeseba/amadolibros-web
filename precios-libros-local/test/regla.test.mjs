import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluar, objetivo99 } from '../src/regla.mjs';
import { REGLA } from '../config.mjs';
import { calcularPiso } from '../src/piso.mjs';

const item = (o = {}) => ({ id: 'MLU1', seller_id: '440298103', site_id: 'MLU', currency_id: 'UYU', status: 'active', variaciones: false, precio_administrado: false, ...o });
const comp = (C, o = {}) => ({ estado: 'ok', tipo: 'catalogo', comparable: true, sinExternos: false, C, ptwStatus: 'competing', ...o });
const lect = (P, C, o = {}) => ({ precio: P, promo: 'ninguna', automatizacion: 'ninguna', comp: comp(C), ...o });
const ev = (P, C, o = {}) => evaluar({ item: item(), lectura: lect(P, C), piso: 1, regla: REGLA, ...o });

test('ejemplo de la regla: 2000 vs 1700, D 300 → 1683', () => {
  const d = ev(2000, 1700);
  assert.equal(d.accion, 'bajar'); assert.equal(d.objetivo, 1683);
  assert.equal(d.calc.D, 300); assert.equal(d.calc.descuentoCorrida, 317); assert.equal(d.calc.supera400, false);
});
test('el umbral se mide antes del 1 %: D 399 baja y el descuento total pasa 400', () => {
  const d = ev(2399, 2000);
  assert.equal(d.accion, 'bajar'); assert.equal(d.objetivo, 1980); assert.equal(d.calc.descuentoCorrida, 419); assert.equal(d.calc.supera400, true);
});
test('D 400 o más no se toca; D 0 o negativo no inicia baja', () => {
  assert.equal(ev(2400, 2000).accion, 'no_tocar_umbral');
  assert.equal(ev(2000, 2000).accion, 'sin_accion_d_no_positiva');
  assert.equal(ev(1900, 2000).accion, 'sin_accion_d_no_positiva');
});
test('objetivo hacia abajo al peso', () => { assert.equal(objetivo99(1234), 1221); assert.equal(objetivo99(1700), 1683); });
test('sin piso no se modifica; bajo el piso se omite sin sustituir el precio', () => {
  assert.equal(ev(2000, 1700, { piso: null }).accion, 'omitir_sin_piso');
  const d = ev(2000, 1700, { piso: 1700 }); assert.equal(d.accion, 'omitir_bajo_piso'); assert.equal(d.objetivo, 1683);
});
test('límite acumulado contra el precio base (20 % y 500)', () => {
  // 1000 vs 700: D 300 < 400, objetivo 693 → 30,7 %: se omite.
  assert.equal(ev(1000, 700).accion, 'omitir_limite_acumulado');
  // Gestionada: base 2000, ya en 1683; el competidor baja a 1550 → objetivo 1534 (23,3 % acumulado): se omite.
  const g = { precio_base: 2000, ultimo_aplicado: 1683, sin_competencia_consecutivas: 0 };
  const d = evaluar({ item: item(), lectura: lect(1683, 1550), gestion: g, piso: 1, regla: REGLA });
  assert.equal(d.accion, 'omitir_limite_acumulado'); assert.equal(d.calc.descAcumUyu, 466);
  // Con el competidor en 1640 → 1623, acumulado 377 (18,85 %): baja.
  assert.equal(evaluar({ item: item(), lectura: lect(1683, 1640), gestion: g, piso: 1, regla: REGLA }).objetivo, 1623);
  // Tope en pesos: base 4000 → objetivo 3465 = 535 pesos (13,4 %): se omite por los 500.
  assert.equal(ev(3800, 3500, { gestion: { precio_base: 4000, ultimo_aplicado: 3800 } }).accion, 'omitir_limite_acumulado');
});
test('exclusiones: promo activa/programada/desconocida, automatización, moneda, otro seller, variaciones', () => {
  assert.equal(ev(2000, 1700, { lectura: lect(2000, 1700, { promo: 'programada' }) }).accion, 'omitir_promocion');
  assert.equal(ev(2000, 1700, { lectura: lect(2000, 1700, { promo: null }) }).accion, 'omitir_promo_desconocida');
  assert.equal(ev(2000, 1700, { lectura: lect(2000, 1700, { automatizacion: 'activa' }) }).accion, 'omitir_automatizacion');
  assert.equal(ev(2000, 1700, { lectura: lect(2000, 1700, { automatizacion: null }) }).accion, 'omitir_automatizacion_desconocida');
  assert.equal(ev(2000, 1700, { item: item({ currency_id: 'USD' }) }).accion, 'omitir_moneda');
  assert.equal(ev(2000, 1700, { item: item({ seller_id: '2341378249' }) }).accion, 'omitir_seller');
  assert.equal(ev(2000, 1700, { item: item({ variaciones: true }) }).accion, 'omitir_variaciones');
});
test('sin catálogo o sin comparabilidad: revisión', () => {
  assert.equal(ev(2000, null, { lectura: lect(2000, null, { comp: { estado: 'ok', tipo: 'sin_catalogo' } }) }).accion, 'revision_sin_comparable');
  assert.equal(ev(2000, 1700, { lectura: lect(2000, 1700, { comp: comp(1700, { comparable: false, motivoComparable: 'ISBN distinto' }) }) }).accion, 'revision_comparabilidad');
  assert.equal(ev(2000, 1700, { lectura: lect(2000, 1700, { comp: comp(1700, { comparable: null }) }) }).accion, 'revision_comparabilidad');
});
test('gestionada: precio cambiado fuera del motor → detener', () => {
  const g = { precio_base: 2000, ultimo_aplicado: 1683 };
  assert.equal(evaluar({ item: item(), lectura: lect(1800, 1700), gestion: g, piso: 1, regla: REGLA }).accion, 'detener_cambio_externo');
});
test('gestionada: el competidor sube → propuesta de recuperar hasta min(base, C×0,99)', () => {
  const g = { precio_base: 2000, ultimo_aplicado: 1683 };
  const d = evaluar({ item: item(), lectura: lect(1683, 1900), gestion: g, piso: 1, regla: REGLA });
  assert.equal(d.accion, 'propuesta_recuperar'); assert.equal(d.objetivo, 1881);
  const d2 = evaluar({ item: item(), lectura: lect(1683, 2500), gestion: g, piso: 1, regla: REGLA });
  assert.equal(d2.accion, 'propuesta_recuperar_base'); assert.equal(d2.objetivo, 2000);
  const d3 = evaluar({ item: item(), lectura: lect(1683, 1900), gestion: g, piso: 1, regla: { ...REGLA, recuperacionHabilitada: true } });
  assert.equal(d3.accion, 'recuperar');
});
test('gestionada: un error NO es desaparición; la desaparición se confirma en 2 corridas', () => {
  const g = { precio_base: 2000, ultimo_aplicado: 1683, sin_competencia_consecutivas: 0 };
  assert.equal(evaluar({ item: item(), lectura: lect(1683, null, { comp: { estado: 'error', error: 'timeout' } }), gestion: g, piso: 1, regla: REGLA }).accion, 'mantener_dato_incierto');
  const sin = lect(1683, null, { comp: comp(null, { sinExternos: true }) });
  assert.equal(evaluar({ item: item(), lectura: sin, gestion: g, piso: 1, regla: REGLA }).accion, 'mantener_confirmando_desaparicion');
  const d = evaluar({ item: item(), lectura: sin, gestion: { ...g, sin_competencia_consecutivas: 1 }, piso: 1, regla: REGLA });
  assert.equal(d.accion, 'propuesta_recuperar_base'); assert.equal(d.objetivo, 2000);
});
test('nunca descuenta 1 % del precio propio: sin cambio de competidor, la gestionada se mantiene', () => {
  const g = { precio_base: 2000, ultimo_aplicado: 1683 };
  assert.equal(evaluar({ item: item(), lectura: lect(1683, 1700), gestion: g, piso: 1, regla: REGLA }).accion, 'sin_accion_d_no_positiva');
});
test('piso: costo + envío + cargo fijo sobre (1 - comisión - margen)', () => {
  assert.equal(calcularPiso({ costo: 800, envio: 150, cargoFijo: 0, comisionPct: 0.15, margenMinPct: 0.10 }), 1267);
  assert.equal(calcularPiso({ costo: 800, envio: null, cargoFijo: 0, comisionPct: 0.15, margenMinPct: 0.10 }), null);
});
