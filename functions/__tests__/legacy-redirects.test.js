import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest as redirectLegacyBook365 } from '../365.js';
import {
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
