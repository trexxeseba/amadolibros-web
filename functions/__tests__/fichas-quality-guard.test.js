// FICHAS-QUALITY-GUARD-1 — el generador automático de las fichas enriquecidas
// no debe producir copy vacío, relleno ni autoría inventada.
//
// Causa raíz corregida: 'Desconocido' y 'Unknown' NO estaban en GENERIC_AUTHORS,
// así que pasaban como autoría real y generaban "Más sobre Desconocido",
// "Ver otros libros de Desconocido" y "lectores de Desconocido".
import test from 'node:test';
import assert from 'node:assert/strict';

import { isGenericAuthor } from '../_shared/showcase-ranking.js';
import { buildAutomaticProductShowcase } from '../_shared/automatic-product-showcase.js';

const GENERICOS = [
  'Desconocido', 'desconocido', 'DESCONOCIDO', '  Desconocido  ',
  'Unknown', 'unknown', 'Unknown Author',
  'Sin autor', 'sin autor',
  'Autor no especificado', 'Autor desconocido', 'Autoría desconocida',
  'No aplica', 'N/A', 'n/a', 'NA', 'S/A', 'S/D',
  'Varios', 'Varios autores',
  'VV. AA.', 'VV AA', 'VVAA', 'AA. VV.', 'AAVV',
  'No especificado', 'Sin especificar', 'Sin datos',
  'Anónimo', 'anonimo',
];

// Ficha real de la cohorte, usada como caso obligatorio de regresión.
const MLU724888358 = Object.freeze({
  id: 'MLU724888358',
  title: 'La Biblia Palabra de Vida — Verbo Divino',
  author: 'Desconocido',
  isbn: '9788490739808',
  publisher: 'Verbo Divino',
  price: 1490,
  available_quantity: 3,
  status: 'active',
  pictures: ['https://http2.mlstatic.com/D_BIBLIA-O.jpg'],
  thumbnail: 'https://http2.mlstatic.com/D_BIBLIA-I.jpg',
  description: '',
  bibliographic: {},
});

const AUTOR_REAL = Object.freeze({
  id: 'MLU111111111',
  title: 'Cien años de soledad',
  author: 'Gabriel García Márquez',
  isbn: '9780307474728',
  publisher: 'Vintage',
  pages: 417,
  description: 'La historia de la familia Buendía a lo largo de siete generaciones en el pueblo de Macondo, fundado por José Arcadio Buendía. Una obra central del realismo mágico latinoamericano que recorre guerras, amores y la soledad como herencia familiar.',
  bibliographic: { genre: 'Novela', language: 'Español', format: 'Tapa blanda' },
});

const SIN_DATOS = Object.freeze({
  id: 'MLU222222222',
  title: 'Cuaderno de trabajo',
  author: 'Varios autores',
  isbn: null,
  publisher: null,
  description: '',
  bibliographic: {},
});

const texto = showcase => JSON.stringify(showcase);

// ── 1. Todos los autores genéricos se convierten en ausencia de autor ──────

test('1. cada variante de autoría genérica se reconoce como ausencia de autor', () => {
  for (const valor of GENERICOS) {
    assert.equal(isGenericAuthor(valor), true, `debía ser genérico: ${JSON.stringify(valor)}`);
  }
  assert.equal(isGenericAuthor(''), true);
  assert.equal(isGenericAuthor(null), true);
  assert.equal(isGenericAuthor(undefined), true);
});

test('1b. un autor real NO se marca como genérico', () => {
  for (const valor of ['Gabriel García Márquez', 'Meg Meeker', 'Martín Nieto', 'Anne Rice']) {
    assert.equal(isGenericAuthor(valor), false, `no debía ser genérico: ${valor}`);
  }
});

// ── 2. Ningún autor genérico genera copy, subtítulo ni enlace interno ──────

test('2. una autoría genérica no produce copy, encabezado, subtítulo ni enlace de autor', () => {
  for (const valor of GENERICOS) {
    const s = buildAutomaticProductShowcase({ ...MLU724888358, author: valor });
    assert.equal(s.authorBio, null, `authorBio debía omitirse para ${valor}`);
    assert.equal(s.authorHeading, null, `authorHeading debía omitirse para ${valor}`);
    assert.equal(s.subtitle, null, `subtitle no debe repetir la autoría genérica ${valor}`);
    for (const link of s.links) {
      assert.doesNotMatch(link.label, /Ver otros libros de/i, `enlace de autor para ${valor}`);
      assert.doesNotMatch(link.href, /q=.*desconocid/i);
    }
    assert.doesNotMatch(texto(s), new RegExp(`Más sobre ${valor}`, 'i'));
  }
});

test('2b. no se sustituye la autoría ausente por una inventada', () => {
  const s = buildAutomaticProductShowcase(MLU724888358);
  assert.doesNotMatch(texto(s), /Equipo editorial|Varios autores|Autor an[óo]nimo/i);
});

// ── 3. Un autor real sigue funcionando ────────────────────────────────────

test('3. un autor real conserva encabezado, copy y enlace interno', () => {
  const s = buildAutomaticProductShowcase(AUTOR_REAL);
  assert.equal(s.authorHeading, 'Más sobre Gabriel García Márquez');
  assert.match(s.authorBio, /Gabriel García Márquez/);
  assert.ok(s.links.some(l => l.label === 'Ver otros libros de Gabriel García Márquez'));
});

// ── 4. Una ficha sin información suficiente omite las secciones débiles ───

test('4. sin datos de edición no se rellenan "Datos destacados" con frases genéricas', () => {
  const s = buildAutomaticProductShowcase(SIN_DATOS);
  assert.doesNotMatch(texto(s), /Disponible para compra inmediata/i);
  assert.doesNotMatch(texto(s), /La ficha reúne los datos aportados por la publicación/i);
  assert.doesNotMatch(texto(s), /Información comercial verificada al momento/i);
  assert.doesNotMatch(texto(s), /Podés consultar cualquier dato de edición antes de comprar\./i);
});

test('4b. el bloque de audiencia (sólo autor + categoría) se omite siempre en la ficha automática', () => {
  for (const item of [MLU724888358, AUTOR_REAL, SIN_DATOS]) {
    const s = buildAutomaticProductShowcase(item);
    assert.equal(s.audience, null, `audience debía omitirse para ${item.id}`);
  }
  const s = buildAutomaticProductShowcase(AUTOR_REAL);
  assert.doesNotMatch(texto(s), /Puede interesar a lectores de/i);
  assert.doesNotMatch(texto(s), /Pensado para lectores de/i);
});

// ── 5. MLU724888358 queda limpia ──────────────────────────────────────────

test('5. MLU724888358 no muestra "Desconocido" en ninguna forma', () => {
  const s = buildAutomaticProductShowcase(MLU724888358);
  const t = texto(s);
  assert.doesNotMatch(t, /Desconocido/i, 'ninguna aparición de "Desconocido"');
  assert.doesNotMatch(t, /Más sobre Desconocido/i);
  assert.doesNotMatch(t, /Ver otros libros de Desconocido/i);
  assert.doesNotMatch(t, /lectores de Desconocido/i);
  // Tampoco debe quedar una fila "Autoría" en los datos de la edición.
  assert.equal(s.editionFacts.some(f => f.label === 'Autoría'), false);
});

test('5b. MLU724888358 conserva los datos concretos que sí tiene', () => {
  const s = buildAutomaticProductShowcase(MLU724888358);
  assert.ok(s.editionFacts.some(f => f.label === 'ISBN' && f.value === '9788490739808'));
  assert.ok(s.editionFacts.some(f => f.label === 'Editorial' && f.value === 'Verbo Divino'));
  assert.equal(s.h1, 'La Biblia Palabra de Vida — Verbo Divino');
  assert.equal(s.verifiedLabel, 'Edición identificada por ISBN');
});

// ── 6. No cambian ISBN, slug, canonical, precio, stock ni imágenes ────────

test('6. el generador no toca ISBN, precio, stock, imágenes ni el id del producto', () => {
  const original = JSON.parse(JSON.stringify(MLU724888358));
  buildAutomaticProductShowcase(MLU724888358);
  assert.deepEqual(JSON.parse(JSON.stringify(MLU724888358)), original, 'el item no debe mutarse');
});

test('6b. el showcase no emite slug ni canonical: no puede alterarlos', () => {
  const s = buildAutomaticProductShowcase(MLU724888358);
  assert.equal('slug' in s, false);
  assert.equal('canonical' in s, false);
  assert.equal('price' in s, false);
  assert.equal('available_quantity' in s, false);
});

// ── 7. Las fichas con descripción real no pierden contenido válido ────────

test('7. una descripción real se conserva íntegra como resumen', () => {
  const s = buildAutomaticProductShowcase(AUTOR_REAL);
  assert.ok(s.summary.length >= 1);
  assert.match(s.summary.join(' '), /Macondo/);
  assert.match(s.summary.join(' '), /realismo mágico/);
  assert.equal(s.introHeading, '¿De qué trata Cien años de soledad?');
});

test('7b. con descripción real los datos destacados siguen presentes', () => {
  const s = buildAutomaticProductShowcase(AUTOR_REAL);
  assert.ok(s.highlights.length >= 3, 'un libro con datos completos conserva sus destacados');
  assert.ok(s.highlights.some(h => /417 páginas/.test(h)));
});

// ── 8. No aparecen frases automáticas de relleno ──────────────────────────

const FRASES_DE_RELLENO = [
  /Disponible para compra inmediata en Amado Libros/i,
  /La ficha reúne los datos aportados por la publicación/i,
  /Información comercial verificada al momento de la consulta/i,
  /Puede interesar a lectores de/i,
  /Puede interesar a quienes buscan lecturas de/i,
  /Pensado para lectores de/i,
  /Para quienes buscan esta obra y necesitan comprobar/i,
  /La publicación no aporta una autoría suficientemente clara/i,
];

test('8. ninguna frase de relleno aparece en la muestra auditada', () => {
  const muestra = [MLU724888358, AUTOR_REAL, SIN_DATOS,
    { ...MLU724888358, author: 'VV. AA.' },
    { ...SIN_DATOS, author: 'Unknown', bibliographic: { genre: 'Religión' } },
  ];
  for (const item of muestra) {
    const t = texto(buildAutomaticProductShowcase(item));
    for (const frase of FRASES_DE_RELLENO) {
      assert.doesNotMatch(t, frase, `frase de relleno en ${item.id}: ${frase}`);
    }
  }
});

// ── 9. El audit debe leer el formato REAL de la cohorte ───────────────────
// Bug detectado en CI: fichas-quality-audit.mjs asumía `cohorte.items` y la
// cohorte publica `ids`. Falló con "ninguna ficha analizable". Este test fija
// el contrato para que el script no vuelva a desincronizarse del formato.

test('9. la cohorte publica `ids` (no `items`) y normalizeShowcaseCohort la acepta', async () => {
  const { normalizeShowcaseCohort } = await import('../_shared/showcase-cohort.js');
  const payload = {
    schema_version: 2,
    total: 2,
    ids: ['MLU724888358', 'MLU111111111'],
    generated_at: '2026-08-24T00:00:00Z',
  };
  const normalizada = normalizeShowcaseCohort(payload);
  assert.ok(normalizada, 'el formato real de la cohorte debe normalizar');
  assert.equal(normalizada.total, 2);
  assert.ok(normalizada.ids.has('MLU724888358'));
  // Un payload con `items` en vez de `ids` NO es válido: es exactamente el
  // formato que el script asumía por error.
  assert.equal(normalizeShowcaseCohort({ schema_version: 2, total: 2, items: payload.ids }), null);
});
