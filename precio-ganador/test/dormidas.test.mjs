import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grupoDe, esDormida } from '../src/dormidas.mjs';

test('grupo por título: tarot, biblias, infantil, crecimiento y el resto', () => {
  assert.equal(grupoDe('Oráculo De La Gratitud Hartfield'), 'tarot_oraculos');
  assert.equal(grupoDe('Biblia Rvr 1960 Letra Grande'), 'biblias_religion');
  assert.equal(grupoDe('Dibujos Para Colorear Pequeñas Princesas'), 'infantil_juvenil');
  assert.equal(grupoDe('La Trampa De La Felicidad'), 'crecimiento_psicologia');
  assert.equal(grupoDe('Cien Años De Soledad'), 'literatura_y_otros');
});

test('dormida: activa, en pesos, con stock, sin visitas y sin anuncio', () => {
  const it = { id: 'MLU1', status: 'active', currency_id: 'UYU', available_quantity: 3 };
  assert.equal(esDormida(it, 0), true);
  assert.equal(esDormida(it, 1), false);
  assert.equal(esDormida(it, 4, { visitasMax: 5 }), true);
  assert.equal(esDormida({ ...it, available_quantity: 2 }, 0), false);
  assert.equal(esDormida({ ...it, status: 'paused' }, 0), false);
  assert.equal(esDormida(it, 0, { conAnuncio: new Set(['MLU1']) }), false);
  assert.equal(esDormida(it, null), false, 'visitas sin leer no se estiman');
});

test('resumen de dormidas con anuncio: estados, impresiones y campaña', async () => {
  const { resumenConAnuncio } = await import('../src/dormidas.mjs');
  const r = resumenConAnuncio([
    { anuncio_estado: 'active', campania_estado: 'active', impresiones: 0, campania: 'A' },
    { anuncio_estado: 'active', campania_estado: 'active', impresiones: 40, campania: 'A' },
    { anuncio_estado: 'paused', campania_estado: 'active', impresiones: 0, campania: 'B' },
    { anuncio_estado: 'active', campania_estado: 'paused', impresiones: 0, campania: 'C' },
  ]);
  assert.equal(r.total, 4); assert.deepEqual(r.por_estado_del_anuncio, { active: 3, paused: 1 });
  assert.equal(r.activas_sin_impresiones, 1); assert.equal(r.activas_con_menos_de_100_impresiones, 1);
  assert.deepEqual(r.por_campania, { A: 2, B: 1, C: 1 });
});
