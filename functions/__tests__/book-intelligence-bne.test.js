import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBneUrl,
  fetchBneEvidence,
  parseBneEvidence,
} from '../../scripts/seo/book-intelligence-bne.mjs';

const ISBN = '9788496836693';
const OTHER_ISBN = '9780194527552';

function marcRecord({ isbn = ISBN, title = 'Padres fuertes, hijas felices', author = 'Meeker, Meg' } = {}) {
  return `
    <record xmlns="http://www.loc.gov/MARC21/slim">
      <leader>00000nam a2200000 i 4500</leader>
      <controlfield tag="001">BNE12345678</controlfield>
      <datafield tag="020" ind1=" " ind2=" "><subfield code="a">${isbn}</subfield></datafield>
      <datafield tag="100" ind1="1" ind2=" "><subfield code="a">${author},</subfield></datafield>
      <datafield tag="245" ind1="1" ind2="0">
        <subfield code="a">${title} :</subfield>
        <subfield code="b">10 secretos que todo padre debería conocer /</subfield>
      </datafield>
      <datafield tag="264" ind1=" " ind2="1">
        <subfield code="b">Ciudadela Libros,</subfield>
        <subfield code="c">2008.</subfield>
      </datafield>
      <datafield tag="300" ind1=" " ind2=" "><subfield code="a">304 p. ;</subfield></datafield>
      <datafield tag="041" ind1="0" ind2=" "><subfield code="a">spa</subfield></datafield>
      <datafield tag="520" ind1=" " ind2=" ">
        <subfield code="a">Registro bibliográfico con una descripción suficientemente extensa para comprobar la extracción semántica del adaptador.</subfield>
      </datafield>
      <datafield tag="650" ind1=" " ind2="0"><subfield code="a">Padres e hijas.</subfield></datafield>
      <datafield tag="650" ind1=" " ind2="0"><subfield code="a">Relaciones familiares.</subfield></datafield>
      <datafield tag="650" ind1=" " ind2="0"><subfield code="a">Educación familiar.</subfield></datafield>
    </record>`;
}

function sruResponse(records) {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/">
      <version>1.2</version>
      <numberOfRecords>${records.length}</numberOfRecords>
      <records>
        ${records.map(record => `<record><recordSchema>marcxml</recordSchema><recordData>${record}</recordData></record>`).join('')}
      </records>
    </searchRetrieveResponse>`;
}

test('URL BNE usa alma.isbn exacto, SRU 1.2 y MARCXML oficial', () => {
  const url = new URL(buildBneUrl(ISBN));
  assert.equal(url.origin, 'https://catalogo.bne.es');
  assert.equal(url.pathname, '/view/sru/34BNE_INST');
  assert.equal(url.searchParams.get('operation'), 'searchRetrieve');
  assert.equal(url.searchParams.get('version'), '1.2');
  assert.equal(url.searchParams.get('query'), `alma.isbn="${ISBN}"`);
  assert.equal(url.searchParams.get('recordSchema'), 'marcxml');
  assert.equal(url.searchParams.get('startRecord'), '1');
});

test('parser BNE revalida 020$a y extrae evidencia bibliográfica fuerte', () => {
  const xml = sruResponse([
    marcRecord(),
    marcRecord({ isbn: OTHER_ISBN, title: 'Otra obra', author: 'Otra, Persona' }),
  ]);
  const records = parseBneEvidence(xml, ISBN);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.source, 'national_library');
  assert.equal(record.source_provider, 'biblioteca_nacional_espana');
  assert.equal(record.source_id, 'BNE12345678');
  assert.equal(record.isbn, ISBN);
  assert.match(record.title, /Padres fuertes, hijas felices/);
  assert.match(record.title, /10 secretos/);
  assert.equal(record.author, 'Meeker, Meg');
  assert.equal(record.publisher, 'Ciudadela Libros');
  assert.equal(record.pages, 304);
  assert.equal(record.language, 'Español');
  assert.equal(record.publication_year, '2008');
  assert.equal(record.topics.length, 3);
  assert.equal(record.raw_quality.exact_isbn, true);
  assert.equal(record.raw_quality.catalog, 'BNE');
});

test('un registro sin el ISBN solicitado nunca se convierte en evidencia', () => {
  const records = parseBneEvidence(sruResponse([marcRecord({ isbn: OTHER_ISBN })]), ISBN);
  assert.deepEqual(records, []);
});

test('fetch BNE es inyectable, pide XML y no requiere secreto', async () => {
  let requestedUrl = null;
  let requestedOptions = null;
  const records = await fetchBneEvidence(ISBN, {
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
  assert.equal(new URL(requestedUrl).searchParams.get('query'), `alma.isbn="${ISBN}"`);
  assert.match(requestedOptions.headers.accept, /xml/);
  assert.equal(records.length, 1);
});

test('error HTTP se propaga y no se convierte en no-match', async () => {
  await assert.rejects(
    () => fetchBneEvidence(ISBN, {
      fetchImpl: async () => ({ ok: false, status: 503, async text() { return ''; } }),
    }),
    /HTTP 503/,
  );
});
