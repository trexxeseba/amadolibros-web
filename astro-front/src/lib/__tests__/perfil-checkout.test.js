import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMPOS_PERFIL,
  CAMPO_A_ID,
  camposACompletar,
  perfilDesdeValores,
  tieneAlgoParaGuardar,
} from '../perfil-checkout.js';

const PERFIL = {
  buyer_name: 'Ana Pérez', buyer_phone: '099111222',
  address: 'Rincón 608', locality: 'Ciudad Vieja', department: 'Montevideo',
};

// Los ids son los que ya tenía el formulario: renombrarlos rompería el
// autocompletado del navegador y los handlers existentes.
test('el mapa apunta a los ids que ya existían en el checkout', () => {
  assert.deepEqual(CAMPO_A_ID, {
    buyer_name: 'buyer-name',
    buyer_phone: 'buyer-phone',
    address: 'delivery-address',
    locality: 'delivery-barrio',
    department: 'delivery-departamento',
  });
  assert.equal(CAMPOS_PERFIL.length, 5);
});

test('con el formulario vacío se completan todos los campos guardados', () => {
  const vacio = { buyer_name: '', buyer_phone: '', address: '', locality: '', department: '' };
  assert.deepEqual(camposACompletar(PERFIL, vacio, []), PERFIL);
});

test('nunca pisa un campo que ya tiene texto', () => {
  const conDatos = { ...PERFIL, buyer_name: 'Otro Nombre Escrito' };
  const r = camposACompletar(PERFIL, conDatos, []);
  assert.deepEqual(r, {}, 'si está todo escrito, no toca nada');
});

test('un campo con sólo espacios cuenta como vacío', () => {
  const r = camposACompletar(PERFIL, { buyer_name: '   ', buyer_phone: '', address: '', locality: '', department: '' }, []);
  assert.equal(r.buyer_name, 'Ana Pérez');
});

// El caso que pide el encargo: la respuesta del perfil llega tarde y la
// persona ya escribió mientras esperaba.
test('una respuesta tardía no sobrescribe lo que se escribió mientras llegaba', () => {
  const alPedir = { buyer_name: '', buyer_phone: '', address: '', locality: '', department: '' };
  // Mientras el pedido viajaba, la persona escribió el teléfono.
  const alLlegar = { ...alPedir, buyer_phone: '098765432' };
  const r = camposACompletar(PERFIL, alLlegar, ['buyer_phone']);
  assert.equal(r.buyer_phone, undefined, 'el teléfono escrito se respeta');
  assert.equal(r.buyer_name, 'Ana Pérez', 'los demás sí se completan');
});

test('un campo tocado y después borrado tampoco se completa', () => {
  const r = camposACompletar(PERFIL, { buyer_name: '', buyer_phone: '', address: '', locality: '', department: '' }, ['buyer_name']);
  assert.equal(r.buyer_name, undefined, 'lo borró a propósito: no se lo devolvemos');
});

test('sin perfil guardado no se completa nada', () => {
  assert.deepEqual(camposACompletar(null, { buyer_name: '' }, []), {});
  assert.deepEqual(camposACompletar({}, { buyer_name: '' }, []), {});
});

test('se guarda lo que hay escrito, y un campo vacío sirve para borrar', () => {
  const perfil = perfilDesdeValores({ buyer_name: '  Ana  Pérez ', buyer_phone: '', address: 'Rincón 608' });
  assert.equal(perfil.buyer_name, 'Ana Pérez');
  assert.equal(perfil.buyer_phone, '');
  assert.equal(perfil.department, '', 'un campo ausente se manda vacío, no undefined');
});

test('no se ofrece guardar un formulario del todo vacío', () => {
  assert.equal(tieneAlgoParaGuardar(perfilDesdeValores({})), false);
  assert.equal(tieneAlgoParaGuardar(perfilDesdeValores({ buyer_phone: '099' })), true);
});
