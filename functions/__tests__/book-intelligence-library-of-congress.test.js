import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLibraryOfCongressUrl,
  fetchLibraryOfCongressEvidence,
  parseLibraryOfCongressEvidence,
} from '../../scripts/seo/book-intelligence-library-of-congress.mjs';

const ISBN = '9788496836693';
const OTHER_ISBN = '9780194527552';

function marcRecord({ isbn = ISBN, title = 'Padres fuertes, hijas felices', author = 'Meeker, Meg' } = {}) {
  return `
    <record xmlns="http://www.loc.gov/MARC21/slim">
      <leader>00000nam a2200000 i 4500</leader>
      <controlfield tag="001">12345678</controlfield>
      <datafield tag="020" ind1=" " ind2=" "><subfield code="a">${isbn} (paperback)</subfield></datafield>
      <datafield tag="100" ind1="1" ind2=" "><subfield code="a">${author},</subfield></datafield>
      <datafield tag="245" ind1="1" ind2="0">
        <subfield code="a">${title} :</subfield>
        <subfield code="b">cómo fortalecer el vínculo familiar /</subfield>
      </datafield>
      <datafield tag="264" ind1=" " ind2="1">
        <subfield code="b">Ciudadela Libros,</subfield>
        <subfield code="c">2008.</subfield>
      </datafield>
      <datafield tag="300" ind1=" " ind2=" "><subfield code="a">304 pages ;</subfield></datafield>
      <datafield tag="041" ind1="0" ind2=" "><subfield code="a">spa</subfield></datafield>
      <datafield tag="520" ind1=" " ind2=" ">
        <subfield code="a">Una síntesis bibliográfica suficientemente extensa sobre la obra, su enfoque práctico y el vínculo entre padres e hijas.</subfield>
      </datafield>
      <datafield tag="650" ind1=" " ind2="0"><subfield code="a">Parent and child.</subfield></datafield>
      <datafield tag="650" ind1=" " ind2="0"><subfield code="a">Father-daughter relationship.</subfield></datafield>
      <datafield tag="650" ind1=" " ind2="0"><subfield code="a">Family relationships.</subfield></datafield>
    </record>`;
}

function sruResponse(records) {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <zs:searchRetrieveResponse xmlns:zs="http://www.loc.gov/zing/srw/">
      <zs:version>1.1</zs:version>
      <zs:numberOfRecords>${records.length}</zs:numberOfRecords>
      <zs:records>
        ${records.map(record => `<zs:record><zs:recordSchema>info:srw/schema/1/marcxml-v1.1</zs:recordSchema><zs:recordData>${record}</zs:recordData></zs:record>`).join('')}
      </zs:records>
    </zs:searchRetrieveResponse>`;
}

test('URL SRU usa bath.isbn exacto, MARCXML y HTTPS oficial', () => {
  const url = new URL(buildLibraryOfCongressUrl(ISBN));
  assert.equal(url.origin, 'https://lx2.loc.gov');
  assert.equal(url.pathname, '/sru/lcdb');
  assert.equal(url.searchParams.get('operation'), 'searchRetrieve');
  assert.equal(url.searchParams.get('query'), `bath.isbn=${ISBN}`);
  assert.equal(url.searchParams.get('recordSchema'), 'marcxml');
});

test('parser MARCXML revalida 020$a y extrae evidencia bibliográfica fuerte', () => {
  const xml = sruResponse([
    marcRecord(),
    marcRecord({ isbn: OTHER_ISBN, title: 'Otra obra', author: 'Otra, Persona' }),
  ]);
  const records = parseLibraryOfCongressEvidence(xml, ISBN);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.source, 'library_catalog');
  assert.equal(record.source_provider, 'library_of_congress');
  assert.equal(record.source_id, '12345678');
  assert.equal(record.isbn, ISBN);
  assert.match(record.title, /Padres fuertes, hijas felices/);
  assert.match(record.title, /cómo fortalecer el vínculo familiar/);
  assert.equal(record.author, 'Meeker, Meg');
  assert.equal(record.publisher, 'Ciudadela Libros');
  assert.equal(record.pages, 304);
  assert.equal(record.language, 'spa');
  assert.equal(record.publication_year, '2008');
  assert.equal(record.topics.length, 3);
  assert.equal(record.raw_quality.exact_isbn, true);
});

test('ISBN sólo en otro registro no se convierte en evidencia del solicitado', () => {
  const records = parseLibraryOfCongressEvidence(
    sruResponse([marcRecord({ isbn: OTHER_ISBN })]),
    ISBN,
  );
  assert.deepEqual(records, []);
});

test('fetch real es inyectable, pide XML y no requiere secreto', async () => {
  let requestedUrl = null;
  let requestedOptions = null;
  const records = await fetchLibraryOfCongressEvidence(ISBN, {
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      requestedOptions = options;
      return {
        ok: true,
        status: 200,
        async text() { return sruResponse([marcRecord()]); },
      };
    },
  });
  assert.equal(new URL(requestedUrl).searchParams.get('query'), `bath.isbn=${ISBN}`);
  assert.match(requestedOptions.headers.accept, /xml/);
  assert.equal(records.length, 1);
});

test('error HTTP se propaga y no se convierte en no-match', async () => {
  await assert.rejects(
    () => fetchLibraryOfCongressEvidence(ISBN, {
      fetchImpl: async () => ({ ok: false, status: 503, async text() { return ''; } }),
    }),
    /HTTP 503/,
  );
});
