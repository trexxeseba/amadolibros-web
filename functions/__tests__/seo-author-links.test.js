import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage, selectRelatedBooks } from '../libro/[[path]].js';

function book(id, author, overrides = {}) {
    return {
        id,
        title: `Libro ${id}`,
        author,
        price: 1200,
        status: 'active',
        available_quantity: 1,
        condition: 'new',
        pictures: [`https://http2.mlstatic.com/D_${id}-O.jpg`],
        permalink: `https://articulo.mercadolibre.com.uy/${id}`,
        ...overrides,
    };
}

test('selecciona hasta cuatro libros activos y con stock del mismo autor', () => {
    const current = book('MLU1', 'Walter Riso');
    const catalog = [
        current,
        book('MLU2', ' walter   riso '),
        book('MLU3', 'Walter Riso'),
        book('MLU4', 'Walter Riso'),
        book('MLU5', 'Walter Riso'),
        book('MLU6', 'Walter Riso'),
        book('MLU7', 'Otro Autor'),
        book('MLU8', 'Walter Riso', { status: 'paused', available_quantity: 0 }),
    ];

    assert.deepEqual(
        selectRelatedBooks(catalog, current).map(item => item.id),
        ['MLU2', 'MLU3', 'MLU4', 'MLU5'],
    );
});

test('no crea enlaces para autores genéricos ni duplica la ficha actual', () => {
    for (const author of ['Varios autores', 'VV. AA.', 'No aplica', 'Anónimo', null]) {
        const current = book('MLU1', author);
        assert.deepEqual(selectRelatedBooks([current, book('MLU2', author)], current), []);
    }
});

test('renderiza enlaces SSR canónicos, portadas diferidas y ningún enlace propio', () => {
    const current = book('MLU1', 'María Montessori', { title: 'Psicogeometría' });
    const related = [
        book('MLU2', 'María Montessori', { title: 'La Mente Absorbente Del Niño' }),
        book('MLU3', 'María Montessori', { title: 'El Niño En La Familia' }),
    ];
    const html = renderPage(current, 'psicogeometria', false, '', '', related);

    assert.match(html, /<section class="related-books"/);
    assert.match(html, /Otros libros de María Montessori/);
    assert.match(html, /href="\/libro\/MLU2\/la-mente-absorbente-del-nino"/);
    assert.match(html, /href="\/libro\/MLU3\/el-nino-en-la-familia"/);
    assert.match(html, /loading="lazy" width="120" height="180"/);
    assert.doesNotMatch(html, /href="\/libro\/MLU1\//);
});

test('escapa autor y títulos antes de insertarlos en HTML', () => {
    const current = book('MLU1', 'Autor <Especial>');
    const related = [book('MLU2', 'Autor <Especial>', { title: 'Libro & Método' })];
    const html = renderPage(current, 'libro', false, '', '', related);

    assert.match(html, /Otros libros de Autor &lt;Especial&gt;/);
    assert.match(html, /Libro &amp; Método/);
    assert.doesNotMatch(html, /Otros libros de Autor <Especial>/);
});
