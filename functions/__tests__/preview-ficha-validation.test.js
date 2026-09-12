import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIELD_CONTRACT,
  ajuste,
  detailRows,
  evaluate,
  normalize,
  productSchema,
  resumirPorCampo,
  schemaEsBook,
} from '../../scripts/seo/preview-ficha-validation.mjs';

// La ficha real arma cada dato como <div class="detail-row"><dt>…</dt><dd>…</dd></div>
// y publica el JSON-LD en un <script>. El verificador tiene que leer SÓLO lo
// primero como "visible".
function ficha({ filas = [], jsonLd = null, extra = '', tipo = 'Product' } = {}) {
  const detalles = filas
    .map(([label, value]) => `<div class="detail-row"><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('');
  const script = jsonLd
    ? `<script type="application/ld+json">${JSON.stringify({ '@type': tipo, ...jsonLd })}</script>`
    : '';
  return `<html><body><dl>${detalles}</dl>${extra}${script}</body></html>`;
}

// Ficha de libro: es donde las propiedades de Book (páginas, formato,
// edición) se exigen en el JSON-LD.
const COMPLETA = ficha({
  tipo: ['Product', 'Book'],
  filas: [['Editorial', 'Oxford University Press'], ['Páginas', '496'], ['Temas', 'Diccionarios · Inglés']],
  jsonLd: { publisher: { name: 'Oxford University Press' }, numberOfPages: 496, keywords: ['Diccionarios', 'Inglés'] },
});

test('sólo se lee como visible lo que está en la lista de detalles', () => {
  const rows = detailRows(COMPLETA);
  assert.equal(rows.get('Editorial'), 'Oxford University Press');
  assert.equal(rows.get('Páginas'), '496');
  assert.equal(rows.size, 3);
});

test('una ficha correcta aprueba con ambas comprobaciones', () => {
  const { comprobaciones } = evaluate(COMPLETA, {
    publisher: 'Oxford University Press', pages: 496, topics: ['Diccionarios', 'Inglés'],
  });
  assert.equal(comprobaciones.length, 3);
  for (const c of comprobaciones) {
    assert.equal(c.ok, true, c.campo);
    assert.equal(c.visible_ok, true, c.campo);
    assert.equal(c.jsonld_ok, true, c.campo);
  }
});

// ---- Casos que DEBEN fallar. La versión anterior los aprobaba. ----

test('un dato que sólo está dentro de un script NO cuenta como visible', () => {
  const soloScript = ficha({ tipo: ['Product', 'Book'], jsonLd: { publisher: { name: 'Oxford University Press' }, numberOfPages: 496 } });
  const { comprobaciones } = evaluate(soloScript, { publisher: 'Oxford University Press', pages: 496 });
  for (const c of comprobaciones) {
    assert.equal(c.visible_ok, false, `${c.campo} no debería contarse como visible`);
    assert.equal(c.ok, false, c.campo);
  }
});

test('un dato visible pero ausente del JSON-LD obligatorio falla', () => {
  const sinJsonLd = ficha({ filas: [['Editorial', 'Oxford University Press']] });
  const [c] = evaluate(sinJsonLd, { publisher: 'Oxford University Press' }).comprobaciones;
  assert.equal(c.visible_ok, true);
  assert.equal(c.jsonld_ok, false);
  assert.equal(c.ok, false, 'no alcanza con una de las dos');
});

test('sin bloque JSON-LD, un campo que lo exige falla', () => {
  const html = ficha({ tipo: ['Product', 'Book'], filas: [['Páginas', '496']] });
  assert.equal(productSchema(html), null);
  assert.equal(evaluate(html, { pages: 496 }).comprobaciones[0].ok, false);
});

test('un número que coincide dentro de otro número no aprueba', () => {
  const otroNumero = ficha({
    tipo: ['Product', 'Book'],
    filas: [['Páginas', '1496']],
    jsonLd: { numberOfPages: 1496 },
  });
  const [c] = evaluate(otroNumero, { pages: 496 }).comprobaciones;
  assert.equal(c.visible_ok, false, '496 no puede aprobar dentro de 1496');
  assert.equal(c.ok, false);
});

test('temas esperados ausentes fallan en vez de pasar sin comprobación', () => {
  const faltanTemas = ficha({
    filas: [['Temas', 'Diccionarios']],
    jsonLd: { keywords: ['Diccionarios'] },
  });
  const [c] = evaluate(faltanTemas, { topics: ['Diccionarios', 'Inglés'] }).comprobaciones;
  assert.equal(c.campo, 'topics');
  assert.equal(c.visible_ok, false, 'falta "Inglés"');
  assert.equal(c.ok, false);
});

// ---- Casos correctos con entidades y espacios ----

test('las entidades HTML y los espacios de más no rompen la comparación', () => {
  const conEntidades = ficha({
    filas: [['Editorial', 'Herder &amp; Herder'], ['Autor', '  Ursula&#39;s   Editor  ']],
    jsonLd: { publisher: { name: 'Herder & Herder' }, author: { name: "Ursula's Editor" } },
  });
  const { comprobaciones } = evaluate(conEntidades, { publisher: 'Herder & Herder', author: "Ursula's Editor" });
  for (const c of comprobaciones) assert.equal(c.ok, true, `${c.campo}: ${c.visible_encontrado}`);
  assert.equal(normalize('  a &amp;  b '), 'a & b');
});

test('los temas se comparan como lista, sin importar el orden', () => {
  const [c] = evaluate(COMPLETA, { topics: ['Inglés', 'Diccionarios'] }).comprobaciones;
  assert.equal(c.ok, true);
});

// El renderizador publica hasta 6 temas en keywords: no se exige el séptimo.
test('sólo se exigen en JSON-LD los temas que el renderizador publica', () => {
  const muchos = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const html = ficha({ filas: [['Temas', muchos.join(' · ')]], jsonLd: { keywords: muchos.slice(0, 6) } });
  assert.equal(evaluate(html, { topics: muchos }).comprobaciones[0].ok, true);
  assert.equal(FIELD_CONTRACT.topics.jsonLdTope, 6);
});

test('todo campo del contrato declara etiqueta visible y propiedad JSON-LD', () => {
  for (const [campo, contrato] of Object.entries(FIELD_CONTRACT)) {
    assert.ok(contrato.etiqueta, `${campo} sin etiqueta visible`);
    assert.equal(typeof contrato.jsonLd, 'function', `${campo} sin propiedad JSON-LD declarada`);
  }
});

test('un campo desconocido se marca sin contrato, nunca aprobado', () => {
  const [c] = evaluate(COMPLETA, { inventado: 'x' }).comprobaciones;
  assert.equal(c.resultado, 'sin_contrato');
  assert.equal(c.ok, false);
});

// El middleware de vidriera publica algunas fichas como `Product` a secas y
// borra a propósito numberOfPages/bookFormat/bookEdition: un producto que no
// es un libro no debe declarar páginas en schema.org. Fue el caso real de
// MLU644234684 (ISBN 9781572813458), que mostraba "250" en la ficha sin
// publicar numberOfPages.
test('en una ficha Product —no Book— las propiedades de libro NO aplican', () => {
  const comoProducto = ficha({
    filas: [['Páginas', '250'], ['Idioma', 'Español']],
    jsonLd: { author: { name: 'Susan Levitt' }, inLanguage: 'Español' },
  });
  const { esBook, comprobaciones } = evaluate(comoProducto, { pages: 250, language: 'Español' });
  assert.equal(esBook, false);
  const paginas = comprobaciones.find(c => c.campo === 'pages');
  assert.equal(paginas.visible_ok, true, 'el dato sí está visible');
  assert.equal(paginas.jsonld_ok, null, 'la propiedad no aplica a un Product');
  assert.match(paginas.jsonld_no_aplica, /Product, no como Book/);
  assert.equal(paginas.ok, true);
  // El idioma NO es exclusivo de Book: se sigue exigiendo.
  const idioma = comprobaciones.find(c => c.campo === 'language');
  assert.equal(idioma.jsonld_ok, true);
});

test('en una ficha Book las propiedades de libro se siguen exigiendo', () => {
  const comoLibro = `<html><body><dl><div class="detail-row"><dt>Páginas</dt><dd>250</dd></div></dl>
    <script type="application/ld+json">${JSON.stringify({ '@type': ['Product', 'Book'], author: { name: 'X' } })}</script>
    </body></html>`;
  const { esBook, comprobaciones } = evaluate(comoLibro, { pages: 250 });
  assert.equal(esBook, true);
  assert.equal(comprobaciones[0].jsonld_ok, false, 'es Book y le falta numberOfPages: falla');
  assert.equal(comprobaciones[0].ok, false);
});

test('sin ningún bloque JSON-LD no se puede alegar que no aplica', () => {
  const sinSchema = ficha({ filas: [['Páginas', '250']] });
  const [c] = evaluate(sinSchema, { pages: 250 }).comprobaciones;
  assert.equal(c.jsonld_ok, false, 'sin schema es una falla, no un "no aplica"');
  assert.equal(c.ok, false);
});

// El informe entregado tiene que poder demostrar, campo por campo, cuántas
// comprobaciones se hicieron: la condición de aceptación es que ningún campo
// esperado quede con cero.
test('el desglose por campo cuenta comprobaciones, aciertos y no aplicables', () => {
  const libro = evaluate(COMPLETA, { publisher: 'Oxford University Press', pages: 496 });
  const producto = evaluate(
    ficha({ filas: [['Páginas', '250']], jsonLd: { author: { name: 'X' } } }),
    { pages: 250 },
  );
  const fallida = evaluate(ficha({ filas: [['Editorial', 'Otra']] }), { publisher: 'Oxford University Press' });

  const porCampo = resumirPorCampo([libro, producto, fallida]);
  assert.deepEqual(porCampo.pages, {
    comprobaciones: 2, visible_ok: 2, jsonld_ok: 1, jsonld_no_aplica: 1, fallidas: 0,
  });
  assert.deepEqual(porCampo.publisher, {
    comprobaciones: 2, visible_ok: 1, jsonld_ok: 1, jsonld_no_aplica: 0, fallidas: 1,
  });
  // Un campo que nadie comprobó no aparece: cero comprobaciones es visible.
  assert.equal(porCampo.topics, undefined);
});

// El mismo verificador corre contra el Preview de un PR y contra Producción.
// Si el nombre nuevo no resolviera, la corrida de Producción leería una base
// vacía y fallaría con un mensaje que no dice nada.
test('FICHA_* manda y PREVIEW_* sigue funcionando como alias', () => {
  assert.equal(ajuste('BASE_URL', { FICHA_BASE_URL: 'https://www.amadolibros.com' }), 'https://www.amadolibros.com');
  assert.equal(ajuste('BASE_URL', { PREVIEW_BASE_URL: 'https://pr-325.amadolibros-web.pages.dev' }), 'https://pr-325.amadolibros-web.pages.dev');
  assert.equal(
    ajuste('BASE_URL', { FICHA_BASE_URL: 'https://www.amadolibros.com', PREVIEW_BASE_URL: 'https://viejo' }),
    'https://www.amadolibros.com',
    'el nombre general gana sobre el alias',
  );
  assert.equal(ajuste('BASE_URL', {}), '');
});
