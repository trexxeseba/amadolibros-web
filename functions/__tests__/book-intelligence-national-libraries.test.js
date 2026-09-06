import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NATIONAL_LIBRARIES,
  buildNationalLibraryUrl,
  fetchNationalLibraryEvidence,
  parseNationalLibraryEvidence,
} from '../../scripts/seo/book-intelligence-national-libraries.mjs';

const ISBN = '9780062273208';
const OTRO_ISBN = '9788496836693';

function marcXml({ isbn = ISBN, title = 'The Hard Thing About Hard Things', author = 'Horowitz, Ben' } = {}) {
  return `<?xml version="1.0"?>
<searchRetrieveResponse>
  <records><record>
    <controlfield tag="001">lc00012345</controlfield>
    <datafield tag="010"><subfield code="a">2013031234</subfield></datafield>
    <datafield tag="020"><subfield code="a">${isbn}</subfield></datafield>
    <datafield tag="245"><subfield code="a">${title} :</subfield></datafield>
    <datafield tag="100"><subfield code="a">${author},</subfield></datafield>
    <datafield tag="264"><subfield code="b">HarperBusiness,</subfield><subfield code="c">2014.</subfield></datafield>
    <datafield tag="300"><subfield code="a">304 pages ;</subfield></datafield>
    <datafield tag="041"><subfield code="a">eng</subfield></datafield>
    <datafield tag="650"><subfield code="a">Entrepreneurship</subfield></datafield>
  </record></records>
</searchRetrieveResponse>`;
}

test('cada biblioteca declara proveedor, catálogo y consulta por ISBN', () => {
  for (const [key, config] of Object.entries(NATIONAL_LIBRARIES)) {
    assert.ok(config.provider, key);
    assert.ok(config.catalog, key);
    assert.equal(typeof config.query, 'function', key);
    assert.match(config.query(ISBN), new RegExp(ISBN), key);
  }
});

test('la URL pide searchRetrieve con MARCXML y el ISBN exacto', () => {
  const url = new URL(buildNationalLibraryUrl('loc', ISBN));
  assert.equal(url.searchParams.get('operation'), 'searchRetrieve');
  assert.equal(url.searchParams.get('recordSchema'), 'marcxml');
  assert.match(url.searchParams.get('query'), new RegExp(ISBN));
});

test('un ISBN inválido o una biblioteca desconocida no construyen URL', () => {
  assert.throws(() => buildNationalLibraryUrl('loc', '123'), /ISBN inválido/);
  assert.throws(() => buildNationalLibraryUrl('inexistente', ISBN), /desconocida/);
});

test('se extraen los hechos bibliográficos del registro MARC', () => {
  const [record] = parseNationalLibraryEvidence('loc', marcXml(), ISBN);
  assert.equal(record.source, 'national_library');
  assert.equal(record.source_provider, 'library_of_congress');
  assert.equal(record.isbn, ISBN);
  assert.equal(record.publisher, 'HarperBusiness');
  assert.equal(record.pages, 304);
  assert.equal(record.publication_year, '2014');
  assert.equal(record.raw_quality.exact_isbn, true);
  assert.equal(record.raw_quality.catalog, 'LoC');
});

// La regla que impide traer datos de otra edición: si el registro devuelto no
// contiene el ISBN pedido, se descarta entero.
test('un registro cuyo 020$a es otro ISBN se descarta', () => {
  const records = parseNationalLibraryEvidence('loc', marcXml({ isbn: OTRO_ISBN }), ISBN);
  assert.deepEqual(records, []);
});

test('DNB usa su propio esquema y proveedor', () => {
  const url = new URL(buildNationalLibraryUrl('dnb', ISBN));
  assert.equal(url.searchParams.get('recordSchema'), 'MARC21-xml');
  const [record] = parseNationalLibraryEvidence('dnb', marcXml(), ISBN);
  assert.equal(record.source_provider, 'deutsche_nationalbibliothek');
  assert.equal(record.raw_quality.catalog, 'DNB');
});

test('el fetch propaga el error HTTP en vez de devolver evidencia vacía', async () => {
  await assert.rejects(
    () => fetchNationalLibraryEvidence('loc', ISBN, {
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /HTTP 503/,
  );
});

test('el adaptador no publica copy: sólo hechos y procedencia', async () => {
  const records = await fetchNationalLibraryEvidence('loc', ISBN, {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => marcXml() }),
  });
  assert.equal(records.length, 1);
  for (const key of Object.keys(records[0])) {
    assert.equal(['price', 'available_quantity', 'canonical', 'currency_id'].includes(key), false);
  }
});

// La consulta SRU de LoC va por HTTP en el puerto 210, así que no puede ser la
// cita publicada: la procedencia usa el permalink canónico del catálogo.
test('la procedencia publicada es un permalink HTTPS, no la consulta SRU', () => {
  const [loc] = parseNationalLibraryEvidence('loc', marcXml(), ISBN);
  assert.equal(loc.source_url, 'https://lccn.loc.gov/2013031234');
  const [dnb] = parseNationalLibraryEvidence('dnb', marcXml(), ISBN);
  assert.equal(dnb.source_url, 'https://d-nb.info/lc00012345');
  for (const record of [loc, dnb]) {
    assert.match(record.source_url, /^https:/);
    assert.doesNotMatch(record.source_url, /searchRetrieve/);
  }
});
