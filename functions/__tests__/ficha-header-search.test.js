// HEADER-FICHA-1: identidad y búsqueda consistentes en la ficha individual.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderPage } from '../libro/[[path]].js';

function render() {
    return renderPage({
        id: 'MLU1', title: 'Un Libro De Prueba', author: 'Autor De Prueba',
        price: 1200, status: 'active', available_quantity: 3,
        condition: 'new', isbn: '9788499809991', publisher: null,
        pages: null, dimensions: null,
        thumbnail: 'https://http2.mlstatic.com/D_1-I.jpg', pictures: [],
        permalink: 'https://articulo.mercadolibre.com.uy/MLU-1-un-libro',
    }, 'un-libro-de-prueba', false, '');
}

test('1. La ficha muestra el logo gráfico real y la marca enlaza al inicio', () => {
    const html = render();
    assert.match(html, /<a href="\/" class="brand-link"[^>]*>/);
    assert.match(html, /<img src="\/images\/logo-amado\.webp" alt="" class="brand-logo"[^>]*fetchpriority="high">/);
    assert.doesNotMatch(html, /logo-amado\.png/);
    assert.match(html, /<span class="brand-name">AMADO LIBROS<\/span>/);
    assert.doesNotMatch(html, />📚 Amado Libros<\/a>/);
});

test('1b. El logo de la ficha existe dentro del public que Astro despliega', async () => {
    const logo = fileURLToPath(new URL('../../astro-front/public/images/logo-amado.webp', import.meta.url));
    await assert.doesNotReject(access(logo));
});

test('2. El buscador de la ficha envía la consulta al catálogo', () => {
    const html = render();
    assert.match(html, /<form class="header-search" action="\/catalogo" method="get" role="search">/);
    assert.match(html, /<input type="search" name="q"/);
    assert.match(html, /placeholder="Buscar por título, autor, temática o ISBN"/);
    assert.match(html, /<button type="submit" aria-label="Buscar libros">Buscar<\/button>/);
});

test('3. Header conserva el carrito y el orden comercial marca → búsqueda → carrito', () => {
    const html = render();
    const header = html.match(/<header class="product-header">[\s\S]*?<\/header>/)?.[0] || '';
    const brand = header.indexOf('class="brand-link"');
    const search = header.indexOf('class="header-search"');
    const cart = header.indexOf('id="ssr-cart-link"');
    assert.ok(brand > -1 && search > -1 && cart > -1);
    assert.ok(brand < search && search < cart);
});

test('4. En mobile el buscador ocupa una segunda fila completa sin ocultarse', () => {
    const html = render();
    assert.match(html, /@media\(max-width:760px\)\{[\s\S]*?\.header-inner\{grid-template-columns:minmax\(0,1fr\) auto;/);
    assert.match(html, /\.header-search\{grid-column:1\/-1;height:42px\}/);
    assert.doesNotMatch(html, /@media\(max-width:760px\)[\s\S]*?\.header-search\{[^}]*display:none/);
});

test('5. El header queda disponible al hacer scroll en la ficha', () => {
    const html = render();
    assert.match(html, /\.product-header\{[^}]*position:sticky;top:0;z-index:50;/);
});
