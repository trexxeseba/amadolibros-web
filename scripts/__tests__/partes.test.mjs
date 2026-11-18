import test from 'node:test';
import assert from 'node:assert/strict';
import { ultimoJson, jsonDespuesDe, cliente } from '../partes/github.mjs';
import { armar, leer } from '../partes/vintage-parte.mjs';
import { evaluar } from '../partes/precio-ganador-control.mjs';

const AHORA = Date.parse('2026-11-18T14:00:00Z');
const VIGIA_OK = { ok: true, vigia_pi: { baseline: false, nuevas_pi: 0, denuncias_abiertas: 0, freno: null }, senales: { avisos_nuevos: 0, avisos_pi: 0, reputacion: { day: '2026-11-18', level: '5_green', cancelaciones: 0.0062, reclamos: 0, demoras: 0.0071, ventas: 152 }, competencia: { day: '2026-11-18', total: 18, por_razon: { 'listed|non_trusted_seller': 18 } } } };
const REGISTRO_VIGIA = `2026-11-18T13:30:33.0591813Z ##[endgroup]\n2026-11-18T13:33:44.6153353Z ${JSON.stringify(VIGIA_OK)}\n2026-11-18T13:33:44.6344051Z Post job cleanup.`;
const corrida = (conclusion, updated_at = '2026-11-18T13:33:46Z') => ({ id: 1, conclusion, updated_at, html_url: 'https://github.com/x/y/actions/runs/1' });
const nubeOk = { corridas: Array.from({ length: 6 }, () => corrida('success')), ultimaOk: corrida('success'), reporte: { estado: 'publicado', freno: { altas_hoy: 120, tope_diario: 300, tanda: 30 }, publicacion: { altas_de_esta_corrida: 30, publicados_total: 29244 } } };

test('el registro se lee quitando la hora de adelante', () => {
  assert.deepEqual(ultimoJson(REGISTRO_VIGIA, '{"ok":'), VIGIA_OK);
  assert.equal(ultimoJson('2026-11-18T13:33:44.6Z {"ok":tru', '{"ok":'), null);
  assert.deepEqual(jsonDespuesDe('2026-11-18T12:40:30.1Z === REPORTE ===\n2026-11-18T12:40:30.2Z {"estado":"publicado"}\n', '=== REPORTE ==='), { estado: 'publicado' });
  assert.equal(jsonDespuesDe('nada', '=== REPORTE ==='), null);
});

test('parte de Vintage normal: cuatro líneas y sin alarma', () => {
  const p = armar({ vigia: { corrida: corrida('success'), salida: VIGIA_OK }, nube: nubeOk, ahora: AHORA });
  assert.equal(p.atencion, false);
  assert.equal(p.asunto, 'todo normal');
  assert.equal(p.lineas.length, 4);
  assert.match(p.lineas[0], /120 altas hoy de 300/);
  assert.match(p.lineas[1], /freno libre/);
  assert.match(p.lineas[2], /5_green/);
  assert.match(p.lineas[3], /18 de 18 .*100 %/);
});

test('parte de Vintage avisa fuerte: freno, infracción, reputación, restricción levantada, vigía parado', () => {
  const con = cambio => armar({ vigia: { corrida: corrida('success'), salida: cambio(structuredClone(VIGIA_OK)) }, nube: nubeOk, ahora: AHORA });
  assert.match(con(v => { v.vigia_pi.freno = { motivo: 'aviso_pi' }; return v; }).asunto, /ATENCIÓN: freno puesto \(aviso_pi\)/);
  assert.match(con(v => { v.vigia_pi.nuevas_pi = 2; return v; }).texto, /2 infracciones nuevas/);
  assert.equal(con(v => { v.senales.reputacion_frena = true; return v; }).atencion, true);
  assert.match(con(v => { v.senales.competencia.por_razon = { 'listed|non_trusted_seller': 15, 'listed|ok': 3 }; return v; }).texto, /levantaron la restricción/);
  assert.equal(con(v => ({ ok: false, error: 'vigia_fallo' })).atencion, true);
  const parado = armar({ vigia: { corrida: corrida('success', '2026-11-18T09:00:00Z'), salida: VIGIA_OK }, nube: nubeOk, ahora: AHORA });
  assert.match(parado.texto, /el vigía no corre desde/);
  const fallas = armar({ vigia: { corrida: corrida('success'), salida: VIGIA_OK }, nube: { ...nubeOk, corridas: [corrida('failure'), ...nubeOk.corridas.slice(1)] }, ahora: AHORA });
  assert.match(fallas.texto, /falló en 1 de las últimas 6/);
});

test('leer usa sólo GET y nunca manda el token fuera de la cabecera', async () => {
  const pedidos = [];
  const fetcher = async (url, opciones) => {
    pedidos.push({ url, metodo: opciones.method ?? 'GET' });
    if (/jobs\/7\/logs/.test(url)) return { ok: true, text: async () => REGISTRO_VIGIA };
    if (/\/jobs/.test(url)) return { ok: true, json: async () => ({ jobs: [{ id: 7 }] }) };
    return { ok: true, json: async () => ({ workflow_runs: [corrida('success')] }) };
  };
  const leido = await leer({ gh: cliente({ token: 'secreto-de-prueba', fetcher }), repo: 'x/y' });
  assert.deepEqual(leido.vigia.salida, VIGIA_OK);
  assert.ok(pedidos.every(p => p.metodo === 'GET' && !p.url.includes('secreto-de-prueba')));
});

const resumen = (extra = {}) => ({ contadores: { fecha: '2026-11-18T12:02:53Z', modo: 'real', activas: 6859, bajadas: 0, ajustadas: 2, subidas: 3, restauradas: 2, verificadas: 7, no_verificadas: 0, errores: 0, ganador_inmediato: 0, ...extra } });

test('control de Precio Ganador: todo bien no pide mail', () => {
  const r = evaluar({ corridas: [corrida('success'), corrida('success'), corrida('success')], vigia: corrida('success'), resumenes: { libros: resumen(), vintage: resumen() }, ahora: AHORA });
  assert.deepEqual(r.atencion, []);
  assert.match(r.texto, /^Todo bien\./);
  assert.match(r.texto, /libros .*ajustadas 2, subidas 3/);
});

test('control de Precio Ganador: marca corridas fallidas, errores, resumen viejo y modo', () => {
  const base = { corridas: [corrida('success')], vigia: corrida('success'), ahora: AHORA };
  assert.match(evaluar({ ...base, corridas: [corrida('failure')], resumenes: { libros: resumen(), vintage: resumen() } }).atencion[0], /terminó en failure/);
  assert.match(evaluar({ ...base, vigia: corrida('failure'), resumenes: { libros: resumen(), vintage: resumen() } }).atencion[0], /vigía/);
  assert.match(evaluar({ ...base, resumenes: { libros: resumen({ errores: 4 }), vintage: resumen() } }).atencion[0], /libros: 4 errores/);
  assert.match(evaluar({ ...base, resumenes: { libros: resumen({ no_verificadas: 1 }), vintage: resumen() } }).atencion[0], /sin verificar/);
  assert.match(evaluar({ ...base, resumenes: { libros: resumen({ fecha: '2026-11-17T12:00:00Z' }), vintage: resumen() } }).atencion[0], /el resumen de libros es del/);
  assert.match(evaluar({ ...base, resumenes: { libros: resumen({ modo: 'prueba' }), vintage: resumen() } }).atencion[0], /modo prueba/);
  assert.match(evaluar({ ...base, resumenes: { libros: resumen(), vintage: null } }).atencion[0], /no se pudo leer el resumen de vintage/);
});
