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
