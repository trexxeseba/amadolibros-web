import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest as redirectLegacyBook365 } from '../365.js';
import {
    legacyResponseForRequest,
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

test('SEO-LEGACY-1 redirige archivos WordPress relevantes a /catalogo', () => {
    const paths = [
        '/shop/',
        '/tienda/',
        '/tienda/page/43/',
        '/tienda/page/999/',
        '/page/88/',
        '/page/95/',
        '/page/122/',
        '/mas-vendidos/',
        '/categoria-producto/infantil/',
        '/categoria-producto/religion/biblias/',
    ];

    for (const path of paths) {
        const response = legacyResponseForRequest(request(path));
        assert.equal(response?.status, 301, path);
        assert.equal(
            response?.headers.get('location'),
            'https://www.amadolibros.com/catalogo',
            path,
        );
    }
});

test('SEO-LEGACY-1 descarta parámetros viejos y evita cadenas desde non-www', () => {
    const response = legacyResponseForRequest(
        request('/shop/?add-to-cart=123&utm_source=legacy', 'amadolibros.com'),
    );

    assert.equal(response?.status, 301);
    assert.equal(
        response?.headers.get('location'),
        'https://www.amadolibros.com/catalogo',
    );
});

test('SEO-LEGACY-1 conserva el host de Preview', () => {
    const response = legacyResponseForRequest(
        request('/tienda/page/43/', 'agent-seo-legacy-1.amadolibros-web.pages.dev'),
    );

    assert.equal(response?.status, 301);
    assert.equal(
        response?.headers.get('location'),
        'https://agent-seo-legacy-1.amadolibros-web.pages.dev/catalogo',
    );
});

test('SEO-LEGACY-1 devuelve 410 útil para rutas sin reemplazo seguro', async () => {
    for (const path of ['/my-orders/', '/2/', '/5/', '/30/', '/85/']) {
        const response = legacyResponseForRequest(request(path));
        const html = await response?.text();

        assert.equal(response?.status, 410, path);
        assert.equal(response?.headers.get('x-robots-tag'), 'noindex, follow', path);
        assert.equal(response?.headers.get('cache-control'), 'no-store', path);
        assert.match(response?.headers.get('content-type') ?? '', /^text\/html/, path);
        assert.match(html ?? '', /href="\/catalogo"/, path);
        assert.match(html ?? '', /href="\/contacto"/, path);
        assert.match(html ?? '', /https:\/\/wa\.me\/59899841325/, path);
    }
});

test('SEO-LEGACY-1 no captura rutas actuales ni patrones parecidos', async () => {
    const paths = [
        '/',
        '/catalogo',
        '/pedido',
        '/page/2/',
        '/tienda-nueva/',
        '/categoria-productos/infantil/',
        '/2/otra-cosa',
    ];

    for (const path of paths) {
        assert.equal(legacyResponseForRequest(request(path)), null, path);

        const response = await middlewareRequest({
            request: request(path),
            async next() {
                return new Response('next');
            },
        });
        assert.equal(await response.text(), 'next', path);
    }
});
