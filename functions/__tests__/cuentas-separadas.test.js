// Desenganche de cuentas de Mercado Libre (Seba, 27/11/2026): Amado Libros (440298103) y Amado
// Vintage (2341378249) no se comunican ni cruzan datos por API. Este test falla si:
//  - un workflow o un job usa las dos cuentas (por scripts, --cuenta, env o secretos);
//  - un workflow de Vintage usa la cuenta Libros, o uno que no es de Vintage usa la cuenta Vintage;
//  - el código de una carpeta de Vintage nombra la cuenta Libros, o al revés;
//  - el Worker de sync (Libros) vuelve a disparar trabajos de Vintage o a usar sus datos;
//  - el lector de tokens deja de exigir una cuenta explícita o de verificar el dueño con /users/me.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fuenteTokenD1} from '../../precio-ganador/src/token.mjs';
import {CUENTAS} from '../../precio-ganador/src/config.mjs';
import {CRONS_PRECIO_GANADOR} from '../../worker-sync/precio-ganador-trigger.js';
import {CRONS_PODA} from '../../worker-sync/poda-trigger.js';

const leer = f => fs.readFileSync(f, 'utf8');
// Sin comentarios de línea (// o #) ni de bloque: los comentarios pueden nombrar la otra cuenta.
const sinComentarios = t => t.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*(\/\/|#|\*)/.test(l)).map(l => l.replace(/\s\/\/.*$/, '')).join('\n');

const MARCAS = {
  libros: [/CUENTAS\.libros\b/, /CUENTAS\[\s*['"]libros['"]\s*\]/, /440298103/, /\bml_oauth\b(?!_sellers)/, /workerTokenSource|pickTokenSource/, /agentes-ml\/src\/config\.mjs/],
  vintage: [/CUENTAS\.vintage\b/, /CUENTAS\[\s*['"]vintage['"]\s*\]/, /CUENTA_HERMES/, /2341378249/, /ml_oauth_sellers/, /opt\(\s*'cuenta'\s*,\s*'vintage'\s*\)/, /VINTAGE_NOTIFY_URL/],
};
const cuentasDelCodigo = texto => {
  const t = sinComentarios(texto);
  return new Set(Object.entries(MARCAS).filter(([, rs]) => rs.some(r => r.test(t))).map(([c]) => c));
};
const cuentasDeScript = f => fs.existsSync(f) ? cuentasDelCodigo(leer(f)) : new Set();

// Jobs de un workflow, por indentación (sin dependencias de YAML).
function jobs(texto) {
  const lineas = texto.split('\n'), out = {};
  const i = lineas.findIndex(l => /^jobs:\s*$/.test(l));
  if (i < 0) return out;
  let actual = null;
  for (const l of lineas.slice(i + 1)) {
    const m = l.match(/^  ([\w-]+):\s*$/);
    if (m) { actual = m[1]; out[actual] = ''; continue; }
    if (/^\S/.test(l)) break;
    if (actual) out[actual] += l + '\n';
  }
  return out;
}
function cuentasDeJob(texto) {
  const t = sinComentarios(texto), s = new Set();
  // Los tests no hablan con Mercado Libre: no cuentan (algunos nombran la otra cuenta para probar el candado).
  for (const m of t.matchAll(/\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*([\w./-]+\.m?js)\b/g)) if (!/\.test\.m?js$/.test(m[1])) for (const c of cuentasDeScript(m[1])) s.add(c);
  for (const m of t.matchAll(/--cuenta[\s=]+["']?(libros|vintage)\b/g)) s.add(m[1]);
  for (const m of t.matchAll(/^\s*(?:CUENTA|IN_CUENTA|CONTROL_CUENTA|VIGIA_CUENTA):\s*["']?(libros|vintage)\b/gm)) s.add(m[1]);
  for (const m of t.matchAll(/^\s*(?:ESTADO_RAMA|VIGIA_WORKFLOW):\s*["']?(\S+?)["']?\s*$/gm)) s.add(/vintage/.test(m[1]) ? 'vintage' : 'libros');
  if (/secrets\.VINTAGE_NOTIFY_URL/.test(t)) s.add('vintage');
  return s;
}

const WF = '.github/workflows';
const workflows = fs.readdirSync(WF).filter(f => /\.ya?ml$/.test(f));
const esDeVintage = f => /vintage|hermes|guardian/.test(f);

test('ningún job de un workflow usa las dos cuentas', () => {
  const mezclados = [];
  for (const f of workflows) for (const [job, cuerpo] of Object.entries(jobs(leer(path.join(WF, f))))) {
    const c = cuentasDeJob(cuerpo);
    if (c.size > 1) mezclados.push(`${f} > ${job}`);
  }
  assert.deepEqual(mezclados, []);
});

test('un workflow de Vintage no usa Libros y uno que no es de Vintage no usa Vintage', () => {
  const mal = [];
  for (const f of workflows) {
    const texto = leer(path.join(WF, f));
    const usadas = new Set(Object.values(jobs(texto)).flatMap(j => [...cuentasDeJob(j)]));
    if (esDeVintage(f) && usadas.has('libros')) mal.push(`${f} (de Vintage) usa Libros`);
    if (!esDeVintage(f) && usadas.has('vintage')) mal.push(`${f} (no es de Vintage) usa Vintage`);
    // Un selector de cuenta con las dos opciones deja que el mismo workflow toque cualquiera.
    if (/options:\s*\[[^\]]*\blibros\b[^\]]*\bvintage\b|options:\s*\[[^\]]*\bvintage\b[^\]]*\blibros\b|\bambas\b/.test(sinComentarios(texto))) mal.push(`${f} deja elegir las dos cuentas`);
  }
  assert.deepEqual(mal, []);
});

test('Precio Ganador: un workflow por cuenta, con cola, estado y alarma propios', () => {
  const libros = leer(path.join(WF, 'precio-ganador.yml')), vintage = leer(path.join(WF, 'precio-ganador-vintage.yml'));
  assert.match(libros, /^\s*group: precio-ganador\s*$/m);
  assert.match(vintage, /^\s*group: precio-ganador-vintage\s*$/m);
  assert.match(libros, /ESTADO_RAMA: estado\/precio-ganador\s*$/m);
  assert.match(vintage, /ESTADO_RAMA: estado\/precio-ganador-vintage\s*$/m);
  assert.match(vintage, /cron: '0 12 \* \* \*'/);
  assert.match(vintage, /cron: '0 0 \* \* \*'/);
  assert.equal((vintage.match(/- cron:/g) ?? []).length, 2);
  assert.match(vintage, /alarma\.mjs "falló la corrida \(vintage\)"/);
  assert.doesNotMatch(libros, /matrix/);
  assert.match(leer(path.join(WF, 'precio-manual.yml')), /IN_CUENTA: libros/);
  assert.match(leer(path.join(WF, 'precio-manual-vintage.yml')), /group: precio-ganador-vintage/);
});

const archivosDe = dir => {
  const out = [];
  const recorrer = d => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, {withFileTypes: true})) {
    if (['node_modules', '__tests__', 'test', 'data'].includes(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) recorrer(p); else if (/\.(m?js|py)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  } };
  recorrer(dir);
  return out;
};
const CARPETAS_VINTAGE = ['scripts/vintage-cloud', 'scripts/vintage-pedidos', 'scripts/vintage-local', 'scripts/guardian', 'hermes-monitor', 'vintage-promos/src'];
const CARPETAS_LIBROS = ['agentes-ml/src', 'poda/src', 'precios-amado/src', 'scripts/mercadolibre'];

test('el código de Vintage no nombra la cuenta Libros y el de Libros no nombra la de Vintage', () => {
  const mal = [];
  for (const f of CARPETAS_VINTAGE.flatMap(archivosDe)) if (cuentasDelCodigo(leer(f)).has('libros')) mal.push(`${f} usa Libros`);
  for (const f of CARPETAS_LIBROS.flatMap(archivosDe)) if (cuentasDelCodigo(leer(f)).has('vintage')) mal.push(`${f} usa Vintage`);
  assert.deepEqual(mal, []);
});

test('ningún script pide el token de las dos cuentas', () => {
  const mal = [];
  for (const f of ['scripts', 'agentes-ml/src', 'poda/src', 'precios-amado/src', 'precio-ganador/src', 'hermes-monitor', 'vintage-promos/src'].flatMap(archivosDe)) {
    if (/precio-ganador[\\/]src[\\/](config|token)\.mjs$/.test(f)) continue;
    const t = sinComentarios(leer(f));
    if (!/fuenteTokenD1|workerTokenSource|ml_oauth/.test(t)) continue;
    if (cuentasDelCodigo(t).size > 1) mal.push(f);
  }
  assert.deepEqual(mal, []);
});

test('el Worker de sync (Libros) no dispara trabajos de Vintage ni usa sus datos', () => {
  const mal = [];
  for (const f of fs.readdirSync('worker-sync').filter(f => /\.js$/.test(f))) {
    const t = sinComentarios(leer(path.join('worker-sync', f)));
    for (const r of [/vintage-nube\.yml/, /hermes-publicar\.yml/, /guardian\.yml/, /vintage-vigia\.yml/, /precio-ganador-vintage\.yml/, /ml_oauth_sellers/, /VINTAGE_NOTIFY_URL/, /VINTAGE_WATCH/, /['"]ambas['"]/, /cuenta:\s*['"]vintage['"]/])
      if (r.test(t)) mal.push(`${f}: ${r}`);
  }
  const index = sinComentarios(leer('worker-sync/index.js'));
  for (const m of index.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) if (/vintage/i.test(m[1]) && !/vintage-pricing/.test(m[1])) mal.push(`index.js importa ${m[1]}`);
  assert.deepEqual(mal, []);
  // Cada cron del Worker tiene su manejador (uno sin manejador cae en la sincronización completa).
  const toml = leer('worker-sync/wrangler.toml');
  const crons = JSON.parse(toml.match(/^crons\s*=\s*(\[.*\])\s*$/m)[1]);
  const conocidos = new Set(['15 7 * * *', '*/5 * * * *', '* * * * *', '55 22 * * *', '58 22 * * *', ...CRONS_PRECIO_GANADOR, ...CRONS_PODA]);
  assert.deepEqual(crons.filter(c => !conocidos.has(c)), []);
  assert.doesNotMatch(sinComentarios(toml), /VINTAGE_/);
});

// ── Lector de tokens: cuenta explícita y dueño verificado ─────────────────────────────────────
const tokenD1 = (dueno, {estado = 200} = {}) => {
  const llamadas = [];
  const fetcher = async (url, o) => {
    llamadas.push(String(url));
    if (String(url).endsWith('/users/me')) return {ok: estado === 200, status: estado, json: async () => ({id: dueno})};
    return {ok: true, status: 200, json: async () => ({success: true, result: [{results: [{access_token: 'T1', access_expires_at: Date.now() + 3600e3}]}]})};
  };
  return {fetcher, llamadas};
};
const opciones = fetcher => ({accountId: 'a', apiTokens: ['t'], fetcher, sleep: async () => {}, esperaMaxMs: 0});

test('el token se pide con una cuenta explícita de CUENTAS', () => {
  assert.throws(() => fuenteTokenD1(undefined, opciones(tokenD1(1).fetcher)), {code: 'cuenta_no_explicita'});
  assert.throws(() => fuenteTokenD1({clave: 'libros', sellerId: '2341378249', token: CUENTAS.libros.token}, opciones(tokenD1(1).fetcher)), {code: 'cuenta_no_explicita'});
  assert.throws(() => fuenteTokenD1({...CUENTAS.vintage, token: CUENTAS.libros.token}, opciones(tokenD1(1).fetcher)), {code: 'cuenta_no_explicita'});
});

test('si /users/me dice que el token es de la otra cuenta, se corta', async () => {
  await assert.rejects(fuenteTokenD1(CUENTAS.libros, opciones(tokenD1(2341378249).fetcher)).getToken(), {code: 'token_de_otra_cuenta_se_esperaba_libros'});
  await assert.rejects(fuenteTokenD1(CUENTAS.vintage, opciones(tokenD1(440298103).fetcher)).getToken(), {code: 'token_de_otra_cuenta_se_esperaba_vintage'});
});

test('con el dueño correcto devuelve el token y verifica una sola vez', async () => {
  const {fetcher, llamadas} = tokenD1(440298103);
  const fuente = fuenteTokenD1(CUENTAS.libros, opciones(fetcher));
  assert.equal(await fuente.getToken(), 'T1');
  assert.equal(await fuente.getToken(), 'T1');
  assert.equal(llamadas.filter(u => u.endsWith('/users/me')).length, 1);
});

test('un token que Mercado Libre rechaza al verificar no se usa', async () => {
  await assert.rejects(fuenteTokenD1(CUENTAS.vintage, opciones(tokenD1(2341378249, {estado: 401}).fetcher)).getToken(), {code: 'token_rechazado_por_ml'});
});
