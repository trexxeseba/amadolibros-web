import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest as redirectLegacyBook365 } from '../365.js';
import {
    LEGACY_CATEGORY_MAP,
    legacyResponseForRequest,
    onRequest as middlewareRequest,
} from '../_middleware.js';
import { findLegacyProductMatch } from '../producto/[[path]].js';

const request = (path, host = 'www.amadolibros.com') =>
    new Request(`https://${host}${path}`);

const contextFor = (path, host = 'www.amadolibros.com', env = { APP_ENV: 'test' }) => ({
    request: request(path, host),
    env,
    async next() {
        return new Response('next');
    },
});

const foundBook = title => async () => ({
    state: 'found',
    item: { id: 'MLU651601362', title },
});

const missingBook = async () => ({ state: 'missing' });
const unavailableBook = async () => ({ state: 'unavailable' });

test('/365 redirige permanentemente a la ficha actual', () => {
    const response = redirectLegacyBook365();

    assert.equal(response.status, 301);
    assert.equal(
        response.headers.get('location'),
        'https://www.amadolibros.com/libro/MLU1330191560/libro-club-de-brujas-mel-knarik-ayelen-romano',
    );
});

test('?book=MLU existente redirige directo a la ficha canónica', async () => {
    const response = await legacyResponseForRequest(
        contextFor('/?book=MLU651601362'),
        { lookupBook: foundBook('El Acuerdo Mary Balogh') },
    );

    assert.equal(response.status, 301);
    assert.equal(
        response.headers.get('location'),
        'https://www.amadolibros.com/libro/MLU651601362/el-acuerdo-mary-balogh',
    );
});

test('?book=MLU pausado existente usa el mismo 301 canónico', async () => {
    const response = await legacyResponseForRequest(
        contextFor('/?book=MLU651601362'),
        { lookupBook: foundBook('Libro Pausado de Prueba') },
    );

    assert.equal(response.status, 301);
    assert.equal(
        response.headers.get('location'),
        'https://www.amadolibros.com/libro/MLU651601362/libro-pausado-de-prueba',
    );
});

test('?book inexistente devuelve 410', async () => {
    const response = await legacyResponseForRequest(
        contextFor('/?book=MLU999999999'),
        { lookupBook: missingBook },
    );

    assert.equal(response.status, 410);
    assert.match(response.headers.get('x-robots-tag'), /noindex/i);
});

test('?book con catálogo temporalmente inaccesible devuelve 503, nunca 410', async () => {
    const response = await legacyResponseForRequest(
        contextFor('/?book=MLU651601362'),
        { lookupBook: unavailableBook },
    );

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '60');
});

test('?book gana sobre add-to-cart y evita perder un producto resoluble', async () => {
    const response = await legacyResponseForRequest(
        contextFor('/page/94/?book=MLU651601362&add-to-cart=156903'),
        { lookupBook: foundBook('El Acuerdo') },
    );

    assert.equal(response.status, 301);
    assert.equal(
        response.headers.get('location'),
        'https://www.amadolibros.com/libro/MLU651601362/el-acuerdo',
    );
});

test('add-to-cart sin mapping WooCommerce → MLU devuelve 410', async () => {
    for (const path of [
        '/?add-to-cart=115745',
        '/page/94/?add-to-cart=156903',
        '/shop/?add-to-cart=123&utm_source=legacy',
    ]) {
        const response = await legacyResponseForRequest(contextFor(path));
        assert.equal(response.status, 410, path);
    }
});

test('paginación histórica /tienda/page/N redirige al catálogo sin trasladar N', async () => {
    for (const path of ['/tienda/page/2', '/tienda/page/43/']) {
        const response = await legacyResponseForRequest(contextFor(path));
        assert.equal(response.status, 301, path);
        assert.equal(
            response.headers.get('location'),
            'https://www.amadolibros.com/catalogo',
            path,
        );
    }
});

test('paginaciones históricas /page/N y /shop/page/N sin equivalencia mantienen 410', async () => {
    for (const path of ['/page/1', '/page/122/', '/shop/page/8/']) {
        const response = await legacyResponseForRequest(contextFor(path));
        assert.equal(response.status, 410, path);
    }
});

test('raíces legacy con equivalente real mantienen 301', async () => {
    const cases = new Map([
        ['/shop', '/catalogo'],
        ['/shop/', '/catalogo'],
        ['/tienda', '/catalogo'],
        ['/tienda/', '/catalogo'],
        ['/mas-vendidos', '/catalogo'],
        ['/mas-vendidos/', '/catalogo'],
        ['/my-orders', '/contacto'],
        ['/my-orders/', '/contacto'],
        ['/categoria-producto/', '/catalogo'],
    ]);

    for (const [path, destination] of cases) {
        const response = await legacyResponseForRequest(contextFor(path));
        assert.equal(response.status, 301, path);
        assert.equal(
            response.headers.get('location'),
            `https://www.amadolibros.com${destination}`,
            path,
        );
    }
});

test('categorías legacy mapeadas redirigen a una landing SEO real', async () => {
    assert.equal(LEGACY_CATEGORY_MAP.novelas, '/libros/literatura-ficcion');

    const response = await legacyResponseForRequest(
        contextFor('/categoria-producto/novelas/'),
    );

    assert.equal(response.status, 301);
    assert.equal(
        response.headers.get('location'),
        'https://www.amadolibros.com/libros/literatura-ficcion',
    );
});

test('categoría legacy sin equivalencia confiable devuelve 410', async () => {
    const response = await legacyResponseForRequest(
        contextFor('/categoria-producto/categoria-imposible/'),
    );
    assert.equal(response.status, 410);
});

test('paginación de categoría legacy devuelve 410 aunque la raíz esté mapeada', async () => {
    const response = await legacyResponseForRequest(
        contextFor('/categoria-producto/novelas/page/261/?layout=list'),
    );
    assert.equal(response.status, 410);
});

test('layout sobre URL actual elimina solo layout y conserva parámetros útiles', async () => {
    const response = await legacyResponseForRequest(
        contextFor('/catalogo?q=tarot&layout=list'),
    );

    assert.equal(response.status, 301);
    assert.equal(
        response.headers.get('location'),
        'https://www.amadolibros.com/catalogo?q=tarot',
    );
});

test('layout sobre URL legacy aplica primero la política legacy', async () => {
    const response = await legacyResponseForRequest(
        contextFor('/categoria-producto/novelas/?layout=list'),
    );

    assert.equal(response.status, 301);
    assert.equal(
        response.headers.get('location'),
        'https://www.amadolibros.com/libros/literatura-ficcion',
    );
});

test('legacy desde non-www va directo al destino final en un solo redirect', async () => {
    const response = await legacyResponseForRequest(
        contextFor('/?book=MLU651601362', 'amadolibros.com'),
        { lookupBook: foundBook('El Acuerdo') },
    );

    assert.equal(response.status, 301);
    assert.equal(
        response.headers.get('location'),
        'https://www.amadolibros.com/libro/MLU651601362/el-acuerdo',
    );
});

test('legacy conserva el host aislado de Preview', async () => {
    const host = 'agent-seo-p3.amadolibros-web.pages.dev';
    const response = await legacyResponseForRequest(
        contextFor('/tienda/', host, { APP_ENV: 'preview' }),
    );

    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), `https://${host}/catalogo`);
});

test('paginación de tienda en Preview conserva el host aislado', async () => {
    const host = 'agent-seo-p3.amadolibros-web.pages.dev';
    const response = await legacyResponseForRequest(
        contextFor('/tienda/page/43/', host, { APP_ENV: 'preview' }),
    );

    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), `https://${host}/catalogo`);
});

test('no captura rutas actuales ni patrones solamente parecidos', async () => {
    const paths = [
        '/',
        '/catalogo',
        '/contacto',
        '/pedido',
        '/page/autores',
        '/page/2/otra-cosa',
        '/tienda-nueva',
        '/tienda/page/dos',
        '/my-orders-history',
        '/mas-vendidos-hoy',
        '/libro/MLU699916310/juego-educativo',
    ];

    for (const path of paths) {
        assert.equal(await legacyResponseForRequest(contextFor(path)), null, path);

        const response = await middlewareRequest(contextFor(path));
        assert.equal(await response.text(), 'next', path);
    }
});

test('cleanup se ejecuta antes de context.next()', async () => {
    let reachedNext = false;
    const context = contextFor('/page/43/');
    context.next = async () => {
        reachedNext = true;
        return new Response('fallback');
    };

    const response = await middlewareRequest(context);
    assert.equal(response.status, 410);
    assert.equal(reachedNext, false);
});

test('/producto conserva match por slug y rechaza el resto', () => {
    const catalog = {
        items: [
            { id: 'MLU1', title: 'El Acuerdo Mary Balogh' },
            { id: 'MLU2', title: 'Otro Libro' },
        ],
    };

    assert.equal(
        findLegacyProductMatch(catalog, 'el-acuerdo-mary-balogh')?.id,
        'MLU1',
    );
    assert.equal(findLegacyProductMatch(catalog, 'slug-inexistente'), null);
});
