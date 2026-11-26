import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    comparisonKey, coverFromFormat, extractYear, itemIsbn, languageFromCode, lookupIsbns,
    mapGoogleBooksVolumes, mapOpenLibraryEdition, normalizeGtinIsbn, resolveField,
} from '../mercadolibre/isbn-public-sources.mjs';

const ISBN = '9780306406157';
const NOW = new Date('2026-11-25T00:00:00Z');

test('normaliza ISBN-10, ISBN-13 con guiones y GTIN-14 con cero adelante', () => {
    assert.equal(normalizeGtinIsbn('0-306-40615-2'), ISBN);
    assert.equal(normalizeGtinIsbn('030640615X'), null);
    assert.equal(normalizeGtinIsbn('978-0-306-40615-7'), ISBN);
    assert.equal(normalizeGtinIsbn('09780306406157'), ISBN);
    assert.equal(normalizeGtinIsbn('0-8044-2957-x'), '9780804429573');
});

test('rechaza lo que no es un ISBN: verificador malo, 12 dígitos, GTIN de otro producto', () => {
    for (const value of ['9780306406158', '978030640615', '07790001234567', '09780306406158', '', null, undefined]) {
        assert.equal(normalizeGtinIsbn(value), null, String(value));
    }
});

test('toma el ISBN de la publicación desde el espejo o desde los atributos crudos', () => {
    assert.equal(itemIsbn({ isbn: ISBN }), ISBN);
    assert.equal(itemIsbn({ attributes: [{ id: 'GTIN', value_name: '09780306406157' }] }), ISBN);
    assert.equal(itemIsbn({ attributes: [{ id: 'isbn', value_name: null, values: [{ name: '0306406152' }] }] }), ISBN);
    assert.equal(itemIsbn({ attributes: [{ id: 'GTIN', value_name: '978030640615' }, { id: 'ISBN', value_name: ISBN }] }), ISBN);
    assert.equal(itemIsbn({ attributes: [{ id: 'AUTHOR', value_name: ISBN }] }), null);
    assert.equal(itemIsbn({}), null);
});

test('una publicación con dos ISBN válidos distintos es ambigua y queda sin ISBN', () => {
    assert.equal(itemIsbn({ attributes: [{ id: 'GTIN', value_name: ISBN, values: [{ name: ISBN }, { name: '9780140449136' }] }] }), null);
});

test('extrae el año sólo cuando hay uno y es razonable', () => {
    assert.equal(extractYear('Apr 21, 2008', NOW), '2008');
    assert.equal(extractYear('2008-04-21', NOW), '2008');
    assert.equal(extractYear('1997', NOW), '1997');
    assert.equal(extractYear('1997-2001', NOW), null);
    assert.equal(extractYear('2099', NOW), null);
    assert.equal(extractYear('s/f', NOW), null);
    assert.equal(extractYear(undefined, NOW), null);
});

test('tapa: sólo formatos inequívocos', () => {
    for (const value of ['paperback', 'Paperback', 'Mass Market Paperback', 'Tapa blanda', 'Rústica', 'Softcover']) assert.equal(coverFromFormat(value), 'Blanda', value);
    for (const value of ['Hardcover', 'hardback', 'Tapa dura', 'Cartoné', 'Library Binding']) assert.equal(coverFromFormat(value), 'Dura', value);
    for (const value of ['Board book', 'Spiral-bound', 'Símil piel', 'Libro de bolsillo', 'Unknown Binding', 'Paperback / Hardcover', 'ebook', '', null]) assert.equal(coverFromFormat(value), null, String(value));
});

test('idioma: códigos conocidos; los demás quedan vacíos', () => {
    assert.equal(languageFromCode('spa'), 'Español');
    assert.equal(languageFromCode('es'), 'Español');
    assert.equal(languageFromCode('en-GB'), 'Inglés');
    assert.equal(languageFromCode('por'), 'Portugués');
    assert.equal(languageFromCode('und'), null);
    assert.equal(languageFromCode(''), null);
});

test('Open Library: mapea una edición completa', () => {
    const edition = {
        title: 'El lugar de la infancia', publish_date: 'Apr 21, 2008', number_of_pages: 258, publishers: ['EDITORIAL GRAO'],
        physical_format: 'paperback', languages: [{ key: '/languages/spa' }], edition_name: '1a ed.', subjects: ['Infancia'],
    };
    assert.deepEqual(mapOpenLibraryEdition(edition, NOW), {
        year: '2008', pages: '258', cover: 'Blanda', language: 'Español', publisher: 'EDITORIAL GRAO', edition: '1a ed.', genre: null,
    });
});

test('Open Library: no infiere lo ambiguo ni lo ausente', () => {
    const facts = mapOpenLibraryEdition({
        publish_date: '199u', number_of_pages: 0, publishers: ['Planeta', 'Seix Barral'], physical_format: 'Unknown Binding',
        languages: [{ key: '/languages/spa' }, { key: '/languages/eng' }], subjects: ['Novela'], pagination: 'xii, 300 p.', title: 'Segunda edición',
    }, NOW);
    assert.equal(facts, null);
    assert.equal(mapOpenLibraryEdition({ publishers: ['Planeta', 'Editorial Planeta'] }, NOW).publisher, 'Planeta');
    assert.equal(mapOpenLibraryEdition(null, NOW), null);
    assert.equal(mapOpenLibraryEdition([], NOW), null);
});

test('Google Books: usa sólo el volumen que declara ese ISBN', () => {
    const volume = (identifier, info) => ({ volumeInfo: { industryIdentifiers: [{ type: 'ISBN_13', identifier }], ...info } });
    const json = { totalItems: 2, items: [
        volume('9780140449136', { publishedDate: '1999', pageCount: 900, language: 'en', publisher: 'Otra' }),
        volume(ISBN, { publishedDate: '2019-05-02', pageCount: 200, language: 'es', publisher: 'Planeta', categories: ['Fiction'] }),
    ] };
    assert.deepEqual(mapGoogleBooksVolumes(json, ISBN, NOW), {
        year: '2019', pages: '200', cover: null, language: 'Español', publisher: 'Planeta', edition: null, genre: null,
    });
    assert.equal(mapGoogleBooksVolumes({ items: [json.items[0]] }, ISBN, NOW), null);
    assert.equal(mapGoogleBooksVolumes({ items: [json.items[1], json.items[1]] }, ISBN, NOW), null);
    assert.equal(mapGoogleBooksVolumes({ totalItems: 0 }, ISBN, NOW), null);
    assert.equal(mapGoogleBooksVolumes({ items: [volume(ISBN, { pageCount: 0 })] }, ISBN, NOW), null);
});

test('Google Books: reconoce el volumen por su ISBN-10', () => {
    const json = { items: [{ volumeInfo: { industryIdentifiers: [{ type: 'ISBN_10', identifier: '0306406152' }], pageCount: 310 } }] };
    assert.equal(mapGoogleBooksVolumes(json, ISBN, NOW).pages, '310');
});

test('regla de discrepancia: una fuente propone, dos que coinciden confirman, dos distintas anulan', () => {
    assert.equal(resolveField('year', [{ source: 'registro', value: null }, { source: 'openlibrary', value: '' }]), null);
    assert.deepEqual(resolveField('year', [{ source: 'openlibrary', value: '2008' }]), { value: '2008', sources: ['openlibrary'] });
    assert.deepEqual(resolveField('pages', [{ source: 'googlebooks', value: '258' }, { source: 'registro', value: 258 }]),
        { value: '258', sources: ['registro', 'googlebooks'] });
    assert.deepEqual(resolveField('pages', [{ source: 'openlibrary', value: '258' }, { source: 'googlebooks', value: '260' }]),
        { discrepancy: [{ source: 'openlibrary', value: '258' }, { source: 'googlebooks', value: '260' }] });
    assert.ok(resolveField('cover', [{ source: 'registro', value: 'Dura' }, { source: 'openlibrary', value: 'Blanda' }]).discrepancy);
    assert.ok(resolveField('year', [{ source: 'registro', value: '2019' }, { source: 'openlibrary', value: '2019' }, { source: 'googlebooks', value: '2020' }]).discrepancy);
});

test('editorial: la misma casa escrita distinto coincide; casas distintas discrepan', () => {
    assert.equal(comparisonKey('publisher', 'Editorial Planeta, S.A.'), comparisonKey('publisher', 'PLANETA'));
    assert.equal(comparisonKey('publisher', 'Ediciones Paidós'), comparisonKey('publisher', 'Paidos'));
    assert.deepEqual(resolveField('publisher', [{ source: 'openlibrary', value: 'EDITORIAL GRAO' }, { source: 'registro', value: 'Graó' }]),
        { value: 'Graó', sources: ['registro', 'openlibrary'] });
    assert.ok(resolveField('publisher', [{ source: 'openlibrary', value: 'Planeta' }, { source: 'googlebooks', value: 'Seix Barral' }]).discrepancy);
    assert.equal(comparisonKey('publisher', 'Ediciones'), 'ediciones');
});

function fakeFetcher(log, replies) {
    return async (url, options) => {
        log.push({ url: String(url), headers: options.headers });
        const reply = replies(String(url));
        return { status: reply.status, json: async () => reply.body };
    };
}

test('consulta: sólo viaja el ISBN, respeta el tope, pausa y guarda en caché', async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'isbn-fuentes-'));
    try {
        const log = [];
        const waits = [];
        const fetcher = fakeFetcher(log, url => url.includes('openlibrary')
            ? (url.includes(ISBN) ? { status: 200, body: { number_of_pages: 258, publish_date: '2008' } } : { status: 404 })
            : { status: 200, body: { totalItems: 0 } });
        const options = { cacheDir, fetcher, wait: async ms => { waits.push(ms); }, pauseMs: 5, now: NOW };
        const isbns = [ISBN, ISBN, '9780140449136', 'no-es-isbn', '9781861972712'];
        const first = await lookupIsbns(isbns, { ...options, limit: 2 });
        assert.equal(first.stats.requested, 2);
        assert.deepEqual([...first.byIsbn.keys()], [ISBN, '9780140449136']);
        assert.equal(first.byIsbn.get(ISBN).openlibrary.pages, '258');
        assert.equal(first.byIsbn.get(ISBN).googlebooks, null);
        assert.deepEqual(first.stats.sources.openlibrary, { with_data: 1, not_found: 1, without_usable_data: 0, errors: 0, skipped_blocked: 0, from_cache: 0, network_calls: 2 });
        assert.equal(first.stats.sources.googlebooks.not_found, 2);
        assert.deepEqual(waits, [5, 5]);
        assert.deepEqual(log.map(call => call.url).sort(), [
            'https://openlibrary.org/isbn/9780140449136.json', `https://openlibrary.org/isbn/${ISBN}.json`,
            'https://www.googleapis.com/books/v1/volumes?q=isbn:9780140449136', `https://www.googleapis.com/books/v1/volumes?q=isbn:${ISBN}`,
        ]);
        for (const call of log) assert.deepEqual(Object.keys(call.headers).sort(), ['accept', 'user-agent']);
        assert.deepEqual((await readdir(path.join(cacheDir, 'openlibrary'))).sort(), ['9780140449136.json', `${ISBN}.json`]);

        const second = await lookupIsbns(isbns, { ...options, limit: 2 });
        assert.equal(log.length, 4, 'la segunda corrida sale entera de la caché');
        assert.equal(second.stats.sources.openlibrary.from_cache, 2);
        assert.equal(second.byIsbn.get(ISBN).openlibrary.year, '2008');
        assert.equal(waits.length, 2);
    } finally {
        await rm(cacheDir, { recursive: true, force: true });
    }
});

test('consulta: una fuente con cuota agotada se deja de consultar y no se guarda el error', async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'isbn-fuentes-'));
    try {
        const log = [];
        const fetcher = fakeFetcher(log, url => url.includes('googleapis') ? { status: 429, body: {} } : { status: 200, body: { number_of_pages: 100 } });
        const isbns = ['9780306406157', '9780140449136', '9781861972712', '9780262033848', '9780131103627'];
        const result = await lookupIsbns(isbns, { cacheDir, fetcher, wait: async () => {}, now: NOW });
        assert.deepEqual(result.stats.sources.googlebooks, { with_data: 0, not_found: 0, without_usable_data: 0, errors: 3, skipped_blocked: 2, from_cache: 0, network_calls: 3 });
        assert.equal(result.stats.sources.openlibrary.with_data, 5);
        assert.deepEqual(await readdir(path.join(cacheDir, 'googlebooks')), []);
        assert.equal(result.byIsbn.get('9780131103627').googlebooks, null);
    } finally {
        await rm(cacheDir, { recursive: true, force: true });
    }
});

test('consulta: un fallo de red cuenta como error y la corrida sigue', async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'isbn-fuentes-'));
    try {
        const fetcher = async url => {
            if (String(url).includes('openlibrary')) throw new Error('sin red');
            return { status: 200, body: null, json: async () => ({ totalItems: 0 }) };
        };
        const result = await lookupIsbns([ISBN], { cacheDir, fetcher, wait: async () => {}, now: NOW });
        assert.equal(result.stats.sources.openlibrary.errors, 1);
        assert.equal(result.byIsbn.get(ISBN).openlibrary, null);
    } finally {
        await rm(cacheDir, { recursive: true, force: true });
    }
});
