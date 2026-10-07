import test from 'node:test';
import assert from 'node:assert/strict';

import {
  projectVerifiedFacts,
  renderFactsModule,
} from '../../scripts/seo/book-intelligence-project.mjs';

const ISBN = '9788496836693';

function manifest(facts = { author: 'Meg Meeker', publisher: 'Ciudadela', pages: 304 }) {
  return {
    generated_at: '2026-08-24T18:00:00.000Z',
    entries: [{ isbn: ISBN, representative_id: 'MLU123456789', decision: 'GREEN_FACTS', facts }],
  };
}

function cache(records) {
  return {
    entries: {
      [ISBN]: {
        bne: { records },
      },
    },
  };
}

test('proyecta hechos exactos de fuente oficial sin texto ni datos comerciales', () => {
  const entries = projectVerifiedFacts({
    manifest: manifest(),
    cache: cache([{
      source: 'national_library',
      source_provider: 'biblioteca_nacional_espana',
      source_url: 'https://catalogo.bne.es/record/1',
      isbn: ISBN,
      author: 'Meg Meeker',
      publisher: 'Ciudadela',
      pages: 304,
      description: 'Texto externo que nunca debe entrar al módulo.',
    }]),
    expected: 1,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sample_listing_id, 'MLU123456789');
  assert.deepEqual(entries[0].facts, {
    author: 'Meg Meeker',
    publisher: 'Ciudadela',
    pages: 304,
  });
  assert.deepEqual(entries[0].provenance[0].fields, ['author', 'pages', 'publisher']);
  const output = renderFactsModule(entries);
  assert.equal(output.includes('Texto externo'), false);
  assert.equal(/price|available_quantity|canonical|pictures/.test(output), false);
});

test('rechaza una sola fuente secundaria aunque el manifiesto venga marcado green', () => {
  assert.throws(() => projectVerifiedFacts({
    manifest: manifest({ pages: 304 }),
    cache: {
      entries: {
        [ISBN]: {
          google_books: { records: [{
            source: 'google_books',
            source_url: 'https://books.google.com/books?id=1',
            isbn: ISBN,
            pages: 304,
          }] },
        },
      },
    },
    expected: 1,
  }), /evidencia suficiente/);
});

test('dos catálogos secundarios coincidentes sí conservan procedencia por campo', () => {
  const record = value => ({ isbn: ISBN, pages: 304, ...value });
  const entries = projectVerifiedFacts({
    manifest: manifest({ pages: 304 }),
    cache: {
      entries: {
        [ISBN]: {
          google_books: { records: [record({
            source: 'google_books', source_url: 'http://books.google.com/books?id=1',
          })] },
          open_library: { records: [record({
            source: 'open_library', source_url: 'https://openlibrary.org/books/OL1M',
          })] },
        },
      },
    },
    expected: 1,
  });
  assert.equal(entries[0].provenance.length, 2);
  assert.equal(entries[0].provenance.every(source => source.fields.includes('pages')), true);
  assert.equal(entries[0].provenance.find(source => source.provider === 'Google Books').url.startsWith('https://'), true);
});

test('la proyección recupera la URL canónica por ISBN de Open Library', () => {
  const record = value => ({ isbn: ISBN, pages: 304, ...value });
  const entries = projectVerifiedFacts({
    manifest: manifest({ pages: 304 }),
    cache: {
      entries: {
        [ISBN]: {
          google_books: { records: [record({
            source: 'google_books', source_url: 'https://books.google.com/books?id=1',
          })] },
          open_library: { records: [record({
            source: 'open_library', source_url: null,
          })] },
        },
      },
    },
    expected: 1,
  });
  assert.equal(
    entries[0].provenance.find(source => source.provider === 'Open Library').url,
    `https://openlibrary.org/isbn/${ISBN}`,
  );
});

test('la proyección compara códigos de idioma antiguos con la etiqueta normalizada', () => {
  const entries = projectVerifiedFacts({
    manifest: manifest({ language: 'Español' }),
    cache: cache([{
      source: 'national_library',
      source_provider: 'biblioteca_nacional_espana',
      source_url: 'https://catalogo.bne.es/record/1',
      isbn: ISBN,
      language: 'spa',
    }]),
    expected: 1,
  });
  assert.equal(entries[0].facts.bibliographic.language, 'Español');
});

test('proyecta temas oficiales sin arrastrar la sinopsis fuente', () => {
  const entries = projectVerifiedFacts({
    manifest: manifest({ topics: ['Educación', 'Familia'] }),
    cache: cache([{
      source: 'national_library',
      source_provider: 'biblioteca_nacional_espana',
      source_url: 'https://catalogo.bne.es/record/1',
      isbn: ISBN,
      topics: ['Familia', 'Educación', 'Otro tema no seleccionado'],
      description: 'No debe proyectarse.',
    }]),
    expected: 1,
  });
  assert.deepEqual(entries[0].facts.bibliographic.subjects, ['Educación', 'Familia']);
  assert.deepEqual(entries[0].provenance[0].fields, ['topics']);
  assert.equal(renderFactsModule(entries).includes('No debe proyectarse'), false);
});

// El lote 34032150352 perdió 53 minutos de investigación porque la proyección
// leía sólo el caché de Google/Open Library/BNE y trataba a toda biblioteca
// nacional como BNE. Estas pruebas fijan las dos correcciones.
test('dos bibliotecas nacionales distintas cuentan como dos proveedores', () => {
  const entries = projectVerifiedFacts({
    manifest: manifest({ pages: 320 }),
    cache: { entries: { [ISBN]: {
      loc: { records: [{
        source: 'national_library', source_provider: 'library_of_congress',
        source_url: 'https://lccn.loc.gov/2013031234', isbn: ISBN, pages: 320,
      }] },
      dnb: { records: [{
        source: 'national_library', source_provider: 'deutsche_nationalbibliothek',
        source_url: 'https://d-nb.info/1234567X', isbn: ISBN, pages: 320,
      }] },
    } } },
    expected: 1,
  });
  assert.equal(entries[0].facts.pages, 320);
  const proveedores = new Set(entries[0].provenance.map(source => source.provider));
  assert.ok(proveedores.has('Library of Congress'));
  assert.ok(proveedores.has('Deutsche Nationalbibliothek'));
  assert.equal(proveedores.size, 2);
});

test('una biblioteca nacional desconocida no se publica como oficial', () => {
  assert.throws(() => projectVerifiedFacts({
    manifest: manifest({ pages: 320 }),
    cache: { entries: { [ISBN]: { loc: { records: [{
      source: 'national_library', source_provider: 'catalogo_inventado',
      source_url: 'https://ejemplo.test/1', isbn: ISBN, pages: 320,
    }] } } } },
    expected: 1,
  }), /no conserva evidencia suficiente/);
});
