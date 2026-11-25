import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { auditar, esCandidato, motivo, MAZO_WORDS } from '../../scripts/commerce/mazos-feed-audit.mjs';

function item(id, extra = {}) {
    return {
        id, title: `Mazo de ${id}`, status: 'active', available_quantity: 2, price: 1500, currency: 'UYU',
        permalink: `https://articulo.mercadolibre.com.uy/${id}`, isbn: null, author: null, ...extra,
    };
}

const ISBN_OK = '9788433920447';

test('candidatos: palabras de búsqueda y ids del inventario de tarot', () => {
    for (const t of ['Tarot de Marsella', 'Oráculo de los ángeles', 'Baraja española', 'Cartas Rider Waite', 'Mazo Lenormand']) {
        assert.ok(MAZO_WORDS.test(t), t);
    }
    assert.equal(MAZO_WORDS.test('Historia de Roma'), false);
    assert.equal(esCandidato({ id: 'MLU9', title: 'Algo' }, new Set(['MLU9'])), true);
});

test('auditar: cuenta los que entran al feed y explica por qué los otros no', () => {
    const items = [
        item('MLU1', { domain_id: 'MLA-BOOKS', isbn: ISBN_OK }),                            // dominio libros → entra
        item('MLU2', { isbn: ISBN_OK }),                                                     // sin dominio, con ISBN → entra
        item('MLU3', { domain_id: 'MLA-PLAYING_CARDS', isbn: ISBN_OK, author: 'Autora' }),   // ISBN + autor → entra
        item('MLU4', { domain_id: 'MLA-PLAYING_CARDS', isbn: ISBN_OK }),                     // ISBN sin autor → no entra
        item('MLU5', { domain_id: 'MLA-PLAYING_CARDS' }),                                    // sin ISBN → no entra
        item('MLU6', { title: 'Tarot sin código' }),                                         // sin dominio ni ISBN → no entra
        item('MLU7', { isbn: ISBN_OK, available_quantity: 0 }),                              // sin stock
        item('MLU8', { status: 'paused', isbn: ISBN_OK }),                                   // pausado: no cuenta
        { ...item('MLU9'), title: 'Historia de Roma' },                                      // no es candidato
    ];
    const r = auditar(items);
    assert.equal(r.catalogo_activo, 8);
    assert.equal(r.candidatos, 7);
    assert.equal(r.entran_al_feed, 3);
    assert.equal(r.fuera_del_feed, 4);
    assert.equal(r.con_isbn_valido, 5);
    assert.deepEqual(r.motivos, {
        'no es libro: ISBN válido, pero sin autor ni páginas': 1,
        'no es libro: tiene dominio y no tiene ISBN válido': 1,
        'no es libro: sin dominio ni ISBN válido': 1,
        'sin stock': 1,
    });
});

test('motivo: cada causa tiene su texto', () => {
    assert.equal(motivo(item('A', { permalink: null })), 'sin enlace');
    assert.equal(motivo(item('A', { available_quantity: 0 })), 'sin stock');
    assert.equal(motivo(item('A', { price: 0 })), 'sin precio');
    assert.equal(motivo(item('A', { currency: 'USD' })), 'moneda no UYU');
});

test('el workflow es manual, de solo lectura y sin secretos', () => {
    const wf = readFileSync('.github/workflows/mazos-feed-audit.yml', 'utf8');
    assert.match(wf, /^on:\n  workflow_dispatch:\n/m);
    assert.match(wf, /permissions:\n  contents: read/);
    assert.doesNotMatch(wf, /secrets\.|id-token|contents: write|push:|pull_request/);
});
