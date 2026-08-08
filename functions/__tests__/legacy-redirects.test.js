import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest as redirectLegacyBook365 } from '../365.js';
import {
    legacyBookRedirectForRequest,
    legacyRedirectForRequest,
    onRequest as middlewareRequest,
} from '../_middleware.js';

test('/365 redirige permanentemente a la ficha actual', () => {
    const response = redirectLegacyBook365();

    assert.equal(response.status, 301);
    assert.equal(
        response.headers.get('location'),
        'https://www.amadolibros.com/libro/MLU1330191560/libro-club-de-brujas-mel-knarik-ayelen-romano',
    );
});

const request = (path, host = 'www.amadolibros.com') =>
    new Request(`https://${host}${path}`);

test('SEO-P3 redirige las rutas históricas de tienda al catálogo', () => {
    const paths = [
        '/shop',
        '/shop/',
        '/tienda',
        '/tienda/',
        '/tienda/page/2',
        '/tienda/page/43/',
        '/shop/page/7/',
        '/page/1',
        '/page/122/',
        '/mas-vendidos',
        '/mas-vendidos/',
    ];

    for (const path of paths) {
        const response = legacyRedirectForRequest(request(path));
        assert.equal(response?.status, 301, path);
        assert.equal(
            response?.headers.get('location'),
            'https://www.amadolibros.com/catalogo',
            path,
        );
    }
});

test('SEO cleanup redirige categorías WooCommerce a la landing equivalente', () => {
    const cases = [
        ['/categoria-producto/psicologia/', '/libros/psicologia'],
        ['/categoria-producto/libros/infantil-y-juvenil/page/3/', '/libros/infantil-juvenil'],
        ['/categoria-producto/medicina-y-salud/', '/libros/medicina-salud'],
        ['/categoria-producto/categoria-sin-equivalencia/', '/catalogo'],
    ];

    for (const [path, destination] of cases) {
        const response = legacyRedirectForRequest(request(path));
        assert.equal(response?.status, 301, path);
        assert.equal(
            response?.headers.get('location'),
            `https://www.amadolibros.com${destination}`,
            path,
        );
    }
});

test('SEO cleanup elimina parámetros WooCommerce y conserva parámetros actuales', () => {
    const cases = [
        ['/?layout=list', 'https://www.amadolibros.com/'],
        ['/?add-to-cart=157057', 'https://www.amadolibros.com/'],
        ['/catalogo?q=tarot&layout=list', 'https://www.amadolibros.com/catalogo?q=tarot'],
        ['/catalogo?add-to-cart=12&q=psicologia', 'https://www.amadolibros.com/catalogo?q=psicologia'],
    ];

    for (const [path, destination] of cases) {
        const response = legacyRedirectForRequest(request(path));
        assert.equal(response?.status, 301, path);
        assert.equal(response?.headers.get('location'), destination, path);
    }
});

test('SEO cleanup responde 410 a recursos internos del WordPress eliminado', () => {
    const response = legacyRedirectForRequest(
        request('/wp-content/plugins/litespeed-cache/guest.vary.php'),
    );

    assert.equal(response?.status, 410);
    assert.equal(response?.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('SEO cleanup resuelve ?book=MLU activo en un solo salto a la ficha canónica', async () => {
    const response = await legacyBookRedirectForRequest({
        request: request('/?book=mlu636144756&layout=list'),
    }, async () => ({
        items: [{
            id: 'MLU636144756',
            title: 'Programa para leerte mejor: libro de actividades',
            status: 'active',
            available_quantity: 1,
        }],
    }));

    assert.equal(response?.status, 301);
    assert.equal(
        response?.headers.get('location'),
        'https://www.amadolibros.com/libro/MLU636144756/programa-para-leerte-mejor-libro-de-actividades',
    );
});

test('SEO cleanup conserva el host de Preview al resolver ?book=MLU', async () => {
    const host = 'agent-seo-cleanup.amadolibros-web.pages.dev';
    const response = await legacyBookRedirectForRequest({
        request: request('/?book=MLU1', host),
    }, async () => ({
        items: [{
            id: 'MLU1',
            title: 'Libro activo',
            status: 'active',
            available_quantity: 1,
        }],
    }));

    assert.equal(response?.status, 301);
    assert.equal(response?.headers.get('location'), `https://${host}/libro/MLU1/libro-activo`);
});

test('SEO cleanup no declara eliminada una ficha si el catálogo falla', async () => {
    const response = await legacyBookRedirectForRequest({
        request: request('/?book=MLU636144756'),
    }, async () => null);

    assert.equal(response?.status, 503);
    assert.equal(response?.headers.get('retry-after'), '60');
    assert.equal(response?.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('SEO cleanup responde 410 a ?book inválido o sin ficha activa', async () => {
    const invalid = await legacyBookRedirectForRequest({
        request: request('/?book=isbn-123'),
    }, async () => {
        throw new Error('no debe consultar el catálogo');
    });
    const inactive = await legacyBookRedirectForRequest({
        request: request('/?book=MLU99'),
    }, async () => ({
        items: [{
            id: 'MLU99',
            title: 'Libro pausado',
            status: 'paused',
            available_quantity: 0,
        }],
    }));

    assert.equal(invalid?.status, 410);
    assert.equal(inactive?.status, 410);
});

test('SEO-P3 redirige el historial de pedidos antiguo a contacto', () => {
    for (const path of ['/my-orders', '/my-orders/']) {
        const response = legacyRedirectForRequest(request(path));
        assert.equal(response?.status, 301, path);
        assert.equal(
            response?.headers.get('location'),
            'https://www.amadolibros.com/contacto',
            path,
        );
    }
});

test('SEO-P3 descarta parámetros viejos y evita una cadena desde non-www', () => {
    const response = legacyRedirectForRequest(
        request('/shop/?add-to-cart=123&utm_source=legacy', 'amadolibros.com'),
    );

    assert.equal(response?.status, 301);
    assert.equal(
        response?.headers.get('location'),
        'https://www.amadolibros.com/catalogo',
    );
});

test('SEO-P3 conserva el host aislado de Preview', () => {
    const host = 'agent-seo-p3.amadolibros-web.pages.dev';
    const response = legacyRedirectForRequest(
        request('/tienda/page/43/?orden=precio', host),
    );

    assert.equal(response?.status, 301);
    assert.equal(
        response?.headers.get('location'),
        `https://${host}/catalogo`,
    );
});

test('SEO-P3 no captura rutas actuales ni patrones solamente parecidos', async () => {
    const paths = [
        '/',
        '/catalogo',
        '/contacto',
        '/pedido',
        '/page/autores',
        '/page/2/otra-cosa',
        '/tienda-nueva',
        '/tienda/page/dos',
        '/5/',
        '/wp-content/uploads/tapa-vieja.jpg',
        '/my-orders-history',
        '/mas-vendidos-hoy',
    ];

    for (const path of paths) {
        assert.equal(legacyRedirectForRequest(request(path)), null, path);

        const response = await middlewareRequest({
            request: request(path),
            async next() {
                return new Response('next');
            },
        });
        assert.equal(await response.text(), 'next', path);
    }
});

test('SEO-P3 se ejecuta en el middleware antes del fallback de la SPA', async () => {
    let reachedNext = false;
    const response = await middlewareRequest({
        request: request('/shop/'),
        async next() {
            reachedNext = true;
            return new Response('fallback');
        },
    });

    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), 'https://www.amadolibros.com/catalogo');
    assert.equal(reachedNext, false);
});
