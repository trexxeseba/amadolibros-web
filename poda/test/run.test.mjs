import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modoEfectivo, grupoDeMetricas, leerArgs } from '../src/run.mjs';
import { armarFilaDiaria, subirFila, ROTULO } from '../src/mesa.mjs';
import { sqlUpsert, lit } from '../src/d1.mjs';

test('modo: real sólo si el archivo lo dice, la variable no frena y no es prueba', () => {
  assert.deepEqual(modoEfectivo({ archivo: 'real', varDryRun: '', prueba: false }), { modo: 'real', real: true });
  assert.equal(modoEfectivo({ archivo: 'real', varDryRun: 'true', prueba: false }).real, false);
  assert.equal(modoEfectivo({ archivo: 'real', varDryRun: '', prueba: true }).real, false);
  assert.equal(modoEfectivo({ archivo: 'dry-run' }).real, false);
  assert.equal(modoEfectivo({ archivo: 'cualquier-cosa' }).modo, 'dry-run');
  assert.equal(modoEfectivo({ archivo: 'off' }).modo, 'off');
  assert.equal(modoEfectivo({}).real, false);
});

test('argumentos', () => assert.deepEqual(leerArgs(['--accion', 'auditar', '--prueba']), { accion: 'auditar', prueba: true }));

test('un anuncio activo de una campaña pausada no se poda; uno protegido queda marcado', () => {
  const camps = new Map([['1', { id: '1', name: 'A', status: 'paused' }], ['2', { id: '2', name: 'B', status: 'active' }]]);
  const g = { id: 10, campaign_id: 1, status: 'ACTIVE', ad_group_type: 'ITEM', ad_group_external_id: 'MLU1', metrics: { clicks: 9, cost: 100 } };
  assert.equal(grupoDeMetricas(g, camps, '2026-11-13', {}).estado, 'CAMPANA_PAUSADA');
  const h = grupoDeMetricas({ ...g, campaign_id: 2 }, camps, '2026-11-13', { campanas: [2] });
  assert.equal(h.estado, 'ACTIVE'); assert.match(h.protegido, /protegida/); assert.deepEqual(h.item_ids, ['MLU1']);
});

test('métricas ausentes cuentan como cero; ventas atribuidas = directas + indirectas', () => {
  const camps = new Map([['2', { id: '2', status: 'active' }]]);
  const g = grupoDeMetricas({ id: 1, campaign_id: 2, status: 'ACTIVE', metrics: null }, camps, 'h', {});
  assert.equal(g.gasto, 0); assert.equal(g.ventasAtribuidas, 0);
  const k = grupoDeMetricas({ id: 1, campaign_id: 2, status: 'ACTIVE', metrics: { direct_units_quantity: 1, indirect_units_quantity: 2 } }, camps, 'h', {});
  assert.equal(k.ventasAtribuidas, 3);
});

const resultado = { contadores: { evaluados: 120, pausar: 0, pausaria: 1, pendientes_pausa: 0, reactivar: 0, observacion: 0 }, listas: { pausar: [], pausaria: [{ titulo: 'Libro', item_ids: ['MLU1'], precio_lista: 2500, gasto: 260, clics: 12, cpc: 21.6, tope: 250 }], pendientesPausa: [], reactivar: [], clicCaro: [], observar: [], faltaPrecio: [], revisar: [], excedentes: [] } };

test('la fila diaria lleva clave poda|fecha, rama Publicidad, nunca Aprobada, y el rótulo de revisión', () => {
  const f = armarFilaDiaria({ fecha: '2026-11-13', accion: 'correr', modo: 'dry-run', real: false, resultado });
  assert.equal(f.fld0pPEWivLADcKOu, 'poda|2026-11-13');
  assert.equal(f.fldyzCiuNdjm94MXj, 'Publicidad');
  assert.equal(f.fldaudDXzXw2BXnnV, 'Poda automatica');
  assert.equal(f.fldsWM8HhUOOKlSSW, 'Nueva');
  assert.match(f.fld7CSwhRc0P8GOm5, /^\[PRUEBA\]/);
  assert.ok(f.fldwtSvMycZShRfJD.includes(ROTULO));
  assert.equal(armarFilaDiaria({ fecha: '2026-11-13', accion: 'auditar', modo: 'real', real: true, resultado }).fld0pPEWivLADcKOu, 'poda|2026-11-13|auditoria');
});

test('sin AIRTABLE_TOKEN no se llama a la red', async () => {
  let llamadas = 0;
  const r = await subirFila({ a: 1 }, { env: {}, fetcher: async () => { llamadas++; return { ok: true }; } });
  assert.deepEqual(r, { ok: false, motivo: 'sin_token' }); assert.equal(llamadas, 0);
});

test('upsert de Airtable por Clave, nunca crea duplicados', async () => {
  let cuerpo = null;
  const r = await subirFila({ x: 1 }, { env: { AIRTABLE_TOKEN: 't' }, fetcher: async (u, o) => { cuerpo = JSON.parse(o.body); assert.equal(o.method, 'PATCH'); return { ok: true }; } });
  assert.equal(r.ok, true); assert.deepEqual(cuerpo.performUpsert.fieldsToMergeOn, ['fld0pPEWivLADcKOu']);
});

test('SQL: comillas escapadas y nulos', () => {
  assert.equal(lit("O'Brien"), "'O''Brien'"); assert.equal(lit(null), 'NULL'); assert.equal(lit(5), '5');
  const s = sqlUpsert({ ad_group_id: '1', estado: 'pausado', origen: 'poda', titulo: "Libro 'raro'", item_ids: ['MLU1'] });
  assert.match(s, /ON CONFLICT\(ad_group_id\)/); assert.match(s, /'Libro ''raro'''/);
});
