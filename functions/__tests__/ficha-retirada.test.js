// Ficha de un libro con la publicación finalizada (ni activa ni pausada).
import assert from 'node:assert/strict';
import test from 'node:test';
import { buscarReemplazo, fichaRetiradaHtml, fichaRetiradaResponse, librosParecidos, tituloDesdeSlug } from '../_shared/ficha-retirada.js';

const ITEMS = [
    { id: 'MLU10', title: 'Biblia Letra Gigante Rvr 1960 Simil Piel Negra', status: 'active', available_quantity: 2, price: 1980 },
    { id: 'MLU11', title: 'Biblia Rvr 1960 Letra Grande. Símil Piel Negro Índice Manual', status: 'active', available_quantity: 0, price: 2890 },
    { id: 'MLU12', title: 'Rayuela', status: 'active', available_quantity: 1, price: 1200 },
    { id: 'MLU13', title: 'Biblia Rvr 1960 Compacta', status: 'paused', available_quantity: 0, price: 1500 },
];
const SLUG = 'biblia-rvr-1960-letra-grande-simil-piel-negro-indice-manual';

test('el título sale del slug de la URL', () => {
    assert.equal(tituloDesdeSlug(SLUG), 'Biblia rvr 1960 letra grande simil piel negro indice manual');
    assert.equal(tituloDesdeSlug(''), '');
    assert.equal(tituloDesdeSlug('%E0%A4'), 'E0 A4');
});

test('redirige solo a otra publicación activa con stock y el mismo título', () => {
    assert.equal(buscarReemplazo(ITEMS, SLUG, 'MLU672387542'), null, 'la que tiene el mismo título está sin stock');
    const conStock = ITEMS.map(i => (i.id === 'MLU11' ? { ...i, available_quantity: 3 } : i));
    assert.equal(buscarReemplazo(conStock, SLUG, 'MLU672387542').id, 'MLU11');
    assert.equal(buscarReemplazo(conStock, SLUG, 'MLU11'), null, 'nunca a sí misma');
});

test('parecidos: con stock y que compartan palabras del título', () => {
    const p = librosParecidos(ITEMS, SLUG);
    assert.deepEqual(p.map(i => i.id), ['MLU10']);
    assert.deepEqual(librosParecidos(ITEMS, 'zzz-yyy-xxx'), []);
});

test('la página invita a encargarlo, con 404 y noindex', async () => {
    const html = fichaRetiradaHtml({ slug: SLUG, parecidos: librosParecidos(ITEMS, SLUG), useCloudflareImages: false });
    assert.match(html, /Se agotó/);
    assert.match(html, /\/pedir-libro\?tipo=agotado&amp;q=Biblia%20rvr%201960/);
    assert.match(html, /wa\.me\/59899841325/);
    assert.match(html, /Parecidos con stock/);
    assert.match(html, /\/libro\/MLU10\//);
    assert.doesNotMatch(html, /Libro no encontrado/);
    const res = fichaRetiradaResponse({ slug: SLUG });
    assert.equal(res.status, 404);
    assert.match(res.headers.get('x-robots-tag'), /noindex/);
});
