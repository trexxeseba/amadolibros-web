import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {evaluar, pendientes, armarMail, ejecutar, describirFiltro, UMBRALES} from '../../scripts/guardian/guardian.mjs';

const AHORA = Date.parse('2026-11-19T12:00:00Z');
const hace = min => new Date(AHORA - min * 60000).toISOString();
const sano = {'arnoia:0': {item_id: 'MLU0', fuente: 'arnoia', ts: AHORA - 10 * 60000}};
const base = (o = {}) => ({runs: {}, publicadas: sano, freno: null, cupo: 800, restantesArnoia: 4000, items: [], ...o});
const claves = h => h.map(x => x.clave);

test('Arnoia atrasada con cupo y libros pendientes: pide una tanda sola', () => {
  const h = evaluar(base({publicadas: {'arnoia:1': {item_id: 'MLU1', fuente: 'arnoia', ts: AHORA - 150 * 60000}}}), AHORA);
  const x = h.find(y => y.clave === 'arnoia_atrasada');
  assert.ok(x); assert.equal(x.accion.tipo, 'dispatch'); assert.equal(x.accion.inputs.fuente, 'arnoia');
});

test('Arnoia al día, sin cupo, sin pendientes o con tanda en curso: no molesta', () => {
  const reciente = {'arnoia:1': {item_id: 'MLU1', fuente: 'arnoia', ts: AHORA - 20 * 60000}};
  assert.ok(!claves(evaluar(base({publicadas: reciente}), AHORA)).includes('arnoia_atrasada'));
  const viejo = {'arnoia:1': {item_id: 'MLU1', fuente: 'arnoia', ts: AHORA - 300 * 60000}};
  assert.ok(!claves(evaluar(base({publicadas: viejo, cupo: 10}), AHORA)).includes('arnoia_atrasada'));
  assert.ok(!claves(evaluar(base({publicadas: viejo, restantesArnoia: 0}), AHORA)).includes('arnoia_atrasada'));
  assert.ok(!claves(evaluar(base({publicadas: viejo, runs: {'hermes-publicar.yml': [{status: 'in_progress', created_at: hace(1)}]}}), AHORA)).includes('arnoia_atrasada'));
});

test('con el freno del vigía puesto: avisa grave y NO pide tandas', () => {
  const h = evaluar(base({freno: {motivo: 'x'}, publicadas: {}}), AHORA);
  assert.deepEqual(claves(h), ['freno_activo']);
  assert.equal(h[0].nivel, 'grave'); assert.equal(h[0].accion, undefined); assert.equal(h[0].opciones.length, 3);
});

test('una corrida caída se reintenta una vez; si cae de nuevo, es grave y se avisa con 3 opciones', () => {
  const caida = n => ({'deploy-worker-sync.yml': [{id: 7, conclusion: 'failure', created_at: hace(30), run_attempt: n, html_url: 'u'}]});
  const a = evaluar(base({runs: caida(1)}), AHORA).find(x => x.clave === 'fallo_7');
  assert.equal(a.accion.tipo, 'rerun'); assert.equal(a.accion.runId, 7);
  const b = evaluar(base({runs: caida(2)}), AHORA).find(x => x.clave === 'fallo_repetido_7');
  assert.equal(b.nivel, 'grave'); assert.equal(b.opciones.length, 3);
  // una falla vieja ya no importa
  assert.deepEqual(claves(evaluar(base({runs: {'deploy-worker-sync.yml': [{id: 8, conclusion: 'failure', created_at: hace(UMBRALES.ventanaFallosMin + 30), run_attempt: 1}]}}), AHORA)), []);
});

test('SBS: sin corridas buenas pide una; tres fallas seguidas es grave', () => {
  const viejas = {'vintage-nube.yml': [{status: 'completed', conclusion: 'success', created_at: hace(200)}]};
  assert.ok(claves(evaluar(base({runs: viejas}), AHORA)).includes('sbs_atrasado'));
  const mal = {'vintage-nube.yml': [1, 2, 3].map(i => ({status: 'completed', conclusion: 'failure', created_at: hace(i * 60)})).concat([{conclusion: 'success', created_at: hace(300)}])};
  const h = evaluar(base({runs: mal}), AHORA);
  assert.equal(h.find(x => x.clave === 'sbs_fallando').nivel, 'grave');
});

test('publicaciones: pausadas por Mercado Libre es grave; fotos cargando es normal hasta 3 horas', () => {
  const norm = evaluar(base({items: [{id: 'MLU1', status: 'paused', sub_status: 'picture_download_pending', edadMin: 10}, {id: 'MLU2', status: 'active', sub_status: '', edadMin: 5}]}), AHORA);
  assert.deepEqual(claves(norm), []);
  const mal = evaluar(base({items: [{id: 'MLU3', status: 'paused', sub_status: 'forbidden', edadMin: 30}]}), AHORA);
  assert.ok(mal[0].clave.startsWith('pausadas_ml_')); assert.equal(mal[0].nivel, 'grave');
  const fotos = evaluar(base({items: [{id: 'MLU4', status: 'paused', sub_status: 'picture_download_pending', edadMin: UMBRALES.fotosMin + 20}]}), AHORA);
  assert.equal(fotos[0].clave, 'fotos_trabadas');
});

test('no repite el aviso dentro de su ventana (3 h; 1 h si es grave)', () => {
  const h = [{clave: 'a', nivel: 'aviso'}, {clave: 'b', nivel: 'grave'}];
  const ya = new Map([['a', AHORA - 2 * 3600e3], ['b', AHORA - 2 * 3600e3]]);
  assert.deepEqual(pendientes(h, ya, AHORA).map(x => x.clave), ['b']);
});

test('ejecutar: hace solo las acciones de la lista; si una falla, la marca grave con opciones; en seco no toca nada', async () => {
  const llamadas = [];
  const deps = {dispatch: async (w, i) => llamadas.push(['dispatch', w, i]), rerun: async id => llamadas.push(['rerun', id])};
  const hechos = await ejecutar([{clave: 'x', nivel: 'aviso', texto: 't', accion: {tipo: 'dispatch', workflow: 'hermes-publicar.yml', inputs: {a: 1}, resumen: 'pedí una tanda'}}, {clave: 'y', nivel: 'aviso', texto: 't', accion: {tipo: 'rerun', runId: 5, resumen: 'reintenté'}}], deps);
  assert.deepEqual(llamadas, [['dispatch', 'hermes-publicar.yml', {a: 1}], ['rerun', 5]]);
  assert.equal(hechos[0].resultado, 'pedí una tanda');
  const roto = await ejecutar([{clave: 'z', nivel: 'aviso', texto: 't', accion: {tipo: 'rerun', runId: 9, resumen: 'r'}}], {...deps, rerun: async () => { throw new Error('github_http_403'); }});
  assert.equal(roto[0].nivel, 'grave'); assert.equal(roto[0].opciones.length, 3);
  const n = llamadas.length;
  await ejecutar([{clave: 'w', nivel: 'aviso', texto: 't', accion: {tipo: 'rerun', runId: 1, resumen: 'r'}}], {...deps, seco: true});
  assert.equal(llamadas.length, n);
});

test('el mail es simple: dice qué pasó, qué se hizo y, si hace falta decidir, 3 opciones', () => {
  const m = armarMail([{texto: 'Falló algo.', nivel: 'aviso', resultado: 'lo reintenté'}]);
  assert.match(m, /No tenés que hacer nada/); assert.match(m, /Qué hice: lo reintenté/);
  const g = armarMail([{texto: 'Algo grave.', nivel: 'grave', opciones: ['a', 'b', 'c']}]);
  assert.match(g, /necesito que mires/); assert.match(g, /3\. c/); assert.match(g, /recomendación es la 1/);
});

test('seguridad: el guardián nunca suelta el freno, reactiva, cambia precios ni nombra Amado Libros', () => {
  const src = fs.readFileSync('scripts/guardian/guardian.mjs', 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/releaseBrake/.test(src), 'no debe soltar el freno');
  assert.ok(!/status:\s*['"]active['"]/.test(src), 'no debe reactivar');
  assert.ok(!/\.put\(|\.post\(/.test(src), 'solo lee de Mercado Libre (la única escritura vive en eliminar.mjs)');
  const el = fs.readFileSync('scripts/guardian/eliminar.mjs', 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(/exigirItemDeVintage/.test(el) && /'active'/.test(el), 'eliminar solo toca Vintage y nunca una activa');
  assert.ok(!/active['"]\s*\}/.test(el) && !/price/.test(el), 'eliminar no reactiva ni cambia precios');
  assert.ok(!/CUENTAS\s*(\.\s*libros|\[\s*['"]libros)/.test(src) && !src.includes('440298103'), 'no debe nombrar Amado Libros');
});

test('una tanda colgada (más de 40 minutos) se cancela y no tapa el aviso de Arnoia atrasada', () => {
  const colgada = {'hermes-publicar.yml': [{id: 99, status: 'in_progress', conclusion: null, created_at: hace(70), html_url: 'u'}]};
  const h = evaluar(base({runs: colgada, publicadas: {'arnoia:1': {item_id: 'MLU1', fuente: 'arnoia', ts: AHORA - 150 * 60000}}}), AHORA);
  const c = h.find(y => y.clave === 'colgada_99');
  assert.ok(c); assert.equal(c.accion.tipo, 'cancel'); assert.equal(c.accion.runId, 99);
  assert.ok(h.some(y => y.clave === 'arnoia_atrasada'), 'la colgada no debe tapar el aviso de Arnoia');
  const normal = {'hermes-publicar.yml': [{id: 98, status: 'in_progress', created_at: hace(5)}]};
  assert.ok(!claves(evaluar(base({runs: normal}), AHORA)).some(k => k.startsWith('colgada_')));
});
test('ejecutar sabe cancelar una corrida', async () => {
  const llamadas = [];
  const h = await ejecutar([{clave: 'c', nivel: 'aviso', texto: 't', accion: {tipo: 'cancel', runId: 7, resumen: 'cancelé'}}], {dispatch: async () => {}, rerun: async () => {}, cancel: async id => llamadas.push(id)});
  assert.deepEqual(llamadas, [7]); assert.equal(h[0].resultado, 'cancelé');
});

test('el informe de una publicación en revisión dice qué libro es, el motivo exacto, qué se hizo con la foto y qué hizo el guardián', () => {
  const item = {id: 'MLU1542039880', status: 'under_review', sub_status: 'waiting_for_patch', edadMin: 90, titulo: 'Centella', autor: 'Matt Tavares', editorial: 'Duomo', fuente: 'arnoia', tradicional: true,
    tapa: 'se usó la tapa de la librería original, sin borrar nada', moderacion: {filtro: 'OCR_GOO_FI_DATOS_PERSONALES_FOTOS_AUTO', motivo: 'Algunas fotos tienen datos de contacto.', remedio: 'Modifica tu publicación y elimina los datos de contacto de tus fotos para reactivarla.'}};
  const h = evaluar(base({items: [item], muestra: 40}), AHORA).find(x => x.clave.startsWith('pausadas_ml_'));
  assert.match(h.asunto, /«Centella» quedó en revisión/);
  const m = armarMail([h]);
  for (const trozo of ['«Centella» (Matt Tavares · Duomo)', 'MLU1542039880', 'de Arnoia, como publicación normal', 'en revisión: Mercado Libre espera', 'no la ve ningún comprador', 'Algunas fotos tienen datos de contacto', 'datos de contacto o identificación en una foto', 'sin borrar nada', 'Qué hice yo: nada todavía', 'no es una denuncia', '1 de las últimas 40', 'Lola y Gaby', 'Mi recomendación es la 1'])
    assert.ok(m.includes(trozo), 'falta: ' + trozo);
  assert.equal(describirFiltro('OCR_GOO_FI_DATOS_PERSONALES_FOTOS_AUTO'), 'datos de contacto o identificación en una foto');
});

const conEtiqueta = (id, o = {}) => ({id, status: 'under_review', sub_status: 'waiting_for_patch', edadMin: 30, titulo: 'Wildwood ' + id, autor: 'Carson Ellis', editorial: 'Duomo', fuente: 'arnoia', tradicional: true,
  tapa: 'se usó la tapa de la librería original, sin borrar nada', moderacion: {filtro: 'OCR_GOO_MELI_LABEL_OCR', motivo: 'Algunas fotos tienen etiquetas de Mercado Libre.'}, ...o});

test('"etiquetas de Mercado Libre" en una foto: el guardián elimina solo y avisa que lo hizo (autorizado por Seba)', async () => {
  const h = evaluar(base({items: [conEtiqueta('MLU1')], muestra: 40}), AHORA);
  const e = h.find(x => x.clave.startsWith('eliminadas_etiquetas_'));
  assert.ok(e, 'debe eliminar');
  assert.deepEqual(e.accion, {tipo: 'eliminar', ids: ['MLU1'], resumen: 'las eliminé (Seba lo autorizó para este motivo)'});
  assert.ok(!h.some(x => x.clave.startsWith('pausadas_ml_')), 'no pide decidir lo que ya resolvió');
  const borradas = [];
  const hechos = await ejecutar([e], {dispatch: async () => {}, rerun: async () => {}, eliminar: async ids => borradas.push(...ids)});
  assert.deepEqual(borradas, ['MLU1']);
  assert.match(armarMail(hechos), /Qué hice yo: las eliminé/);
});

test('solo elimina por ese motivo: denuncias, datos de contacto y otros siguen pidiendo decisión', () => {
  const otra = conEtiqueta('MLU2', {moderacion: {filtro: 'ML_DP_ATRIBUTOS', motivo: 'La ficha técnica incluye datos de contacto.'}});
  const h = evaluar(base({items: [otra, conEtiqueta('MLU3', {status: 'active', sub_status: ''})], muestra: 40}), AHORA);
  assert.ok(!h.some(x => x.accion?.tipo === 'eliminar'));
  assert.ok(h.some(x => x.clave.startsWith('pausadas_ml_')));
});

test('si son demasiadas de golpe (más de 10) no borra: avisa grave para que se mire', () => {
  const muchas = Array.from({length: 11}, (_, i) => conEtiqueta('MLU' + (100 + i)));
  const h = evaluar(base({items: muchas, muestra: 40}), AHORA);
  assert.ok(!h.some(x => x.accion?.tipo === 'eliminar'));
  assert.equal(h.find(x => x.clave.startsWith('pausadas_ml_')).nivel, 'grave');
});

test('las ya eliminadas no vuelven a avisarse', () => {
  const ya = conEtiqueta('MLU4', {status: 'inactive', sub_status: 'waiting_for_patch,deleted'});
  assert.deepEqual(claves(evaluar(base({items: [ya], muestra: 40}), AHORA)).filter(c => /eliminadas_|pausadas_/.test(c)), []);
});
