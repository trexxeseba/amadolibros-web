import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listaDemanda, enviarListaDemanda } from '../src/reporte.mjs';

const fila = (id, dias, demanda) => ({ item: { id, title: 'Libro ' + id, price: 1000 }, comp: { ganador: 850 }, perdida: { ganador_precio: 850, ganador_dias: dias, contra_demanda: demanda, competidores: 2 } });

test('la lista trae sólo las que pierden contra vendedores a demanda, las más lentas primero', () => {
  const l = listaDemanda([fila('MLU1', 8, true), fila('MLU2', 2, false), fila('MLU3', 20, true), { item: { id: 'MLU4' } }]);
  assert.deepEqual(l.map(x => x.id), ['MLU3', 'MLU1']);
  assert.match(l[0].permalink, /MLU-3/);
});
test('el mail va a adm@amadolibros.com.uy; sin casos no se manda', async () => {
  process.env.RESEND_API_KEY = 'k';
  let body = null;
  const fetcher = async (url, o) => { body = JSON.parse(o.body); return new Response('{}', { status: 200 }); };
  assert.equal((await enviarListaDemanda({ cuenta: { clave: 'libros', nombre: 'Amado Libros' }, lista: [], fetcher })).status, 'sin_casos');
  const r = await enviarListaDemanda({ cuenta: { clave: 'libros', nombre: 'Amado Libros' }, lista: listaDemanda([fila('MLU3', 20, true)]), fetcher });
  assert.equal(r.status, 'enviado');
  assert.ok(body.to.includes('adm@amadolibros.com.uy'));
  assert.match(body.subject, /fuera de catálogo/);
  assert.doesNotMatch(body.html + body.text, /únicamente|sólo /);
  delete process.env.RESEND_API_KEY;
});
