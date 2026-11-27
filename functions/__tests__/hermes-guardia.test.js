import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {exigirVintage, exigirItemDeVintage} from '../../hermes-monitor/guardia.mjs';
import {decide} from '../../.claude/hooks/guard-amado-libros.mjs';

const VINTAGE = 2341378249;

test('el candado corta si el token no es de Vintage', async () => {
  await assert.rejects(exigirVintage({get: async () => ({id: 999})}), {code: 'cuenta_equivocada_el_token_no_es_de_vintage'});
  await assert.rejects(exigirVintage({get: async () => { throw new Error('x'); }}), {code: 'cuenta_equivocada_el_token_no_es_de_vintage'});
  assert.deepEqual(await exigirVintage({get: async () => ({id: VINTAGE})}), {id: VINTAGE});
});

test('una publicación de otra cuenta se detecta', () => {
  assert.throws(() => exigirItemDeVintage({seller_id: 111}), {code: 'publicacion_en_cuenta_equivocada'});
  assert.doesNotThrow(() => exigirItemDeVintage({seller_id: VINTAGE}));
});

const leer = f => fs.readFileSync(f, 'utf8');
const sinComentarios = t => t.split('\n').filter(l => !/^\s*(\/\/|#)/.test(l)).join('\n');

test('el código de Hermes no puede nombrar la cuenta de Amado Libros', () => {
  const archivos = [
    ...fs.readdirSync('hermes-monitor').filter(f => /\.(mjs|py)$/.test(f)).map(f => path.join('hermes-monitor', f)),
    ...fs.readdirSync('.github/workflows').filter(f => /^hermes-.*\.yml$/.test(f)).map(f => path.join('.github/workflows', f)),
  ];
  for (const f of archivos) {
    const t = sinComentarios(leer(f));
    assert.ok(!/CUENTAS\s*(\.\s*libros|\[\s*['"]libros)/.test(t), `${f} usa la cuenta Libros`);
    assert.ok(!t.includes('440298103'), `${f} nombra el seller de Amado Libros`);
  }
});

test('crear publicaciones (POST /items) solo en el publicador de Hermes, y con el candado', () => {
  const lugares = [];
  const recorrer = d => { for (const e of fs.readdirSync(d, {withFileTypes: true})) {
    if (e.name === 'node_modules' || e.name === '__tests__' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) recorrer(p); else if (/\.(mjs|js)$/.test(e.name) && /\.post\(\s*['"`]\/items['"`]/.test(leer(p))) lugares.push(p.split(path.sep).join('/'));
  } };
  ['hermes-monitor', 'scripts', 'precio-ganador'].forEach(recorrer);
  assert.deepEqual(lugares, ['hermes-monitor/publicar.mjs']);
  const pub = leer('hermes-monitor/publicar.mjs');
  assert.match(pub, /await exigirVintage\(ml\)/);
  assert.match(pub, /exigirItemDeVintage/);
});

test('el freno de sesiones avisa si un cambio usa CUENTAS.libros', () => {
  const r = decide({tool_name: 'Edit', tool_input: {file_path: 'hermes-monitor/x.mjs', new_string: "crearCliente(fuenteTokenD1(CUENTAS.libros))"}});
  assert.match(String(r), /Amado Libros/);
  assert.equal(decide({tool_name: 'Edit', tool_input: {file_path: 'hermes-monitor/x.mjs', new_string: "CUENTAS.vintage"}}), null);
});
