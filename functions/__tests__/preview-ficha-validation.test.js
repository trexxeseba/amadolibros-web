import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIELD_CONTRACT,
  detailRows,
  evaluate,
  normalize,
  productSchema,
} from '../../scripts/seo/preview-ficha-validation.mjs';

// La ficha real arma cada dato como <div class="detail-row"><dt>…</dt><dd>…</dd></div>
// y publica el JSON-LD en un <script>. El verificador tiene que leer SÓLO lo
// primero como "visible".
function ficha({ filas = [], jsonLd = null, extra = '' } = {}) {
  const detalles = filas
    .map(([label, value]) => `<div class="detail-row"><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('');
  const script = jsonLd
    ? `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', ...jsonLd })}</script>`
    : '';
  return `<html><body><dl>${detalles}</dl>${extra}${script}</body></html>`;
}

const COMPLETA = ficha({
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
  const soloScript = ficha({ jsonLd: { publisher: { name: 'Oxford University Press' }, numberOfPages: 496 } });
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
  const html = ficha({ filas: [['Páginas', '496']] });
  assert.equal(productSchema(html), null);
  assert.equal(evaluate(html, { pages: 496 }).comprobaciones[0].ok, false);
});

test('un número que coincide dentro de otro número no aprueba', () => {
  const otroNumero = ficha({
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
