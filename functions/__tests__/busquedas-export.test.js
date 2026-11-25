import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { generosNormalizados, limpiar, resumir, aMarkdown, TEMAS } from '../../scripts/ops/busquedas-export.mjs';

const filas = [
    { date: '2026-11-02', query: 'zzzinexistente999', count: 40 },
    { date: '2026-11-02', query: 'tarot de marsella', count: 3 },
    { date: '2026-11-03', query: 'tarot de marsella', count: 2 },
    { date: '2026-11-09', query: 'psicologia infantil', count: 1 },
    { date: '2026-11-09', query: 'la agonia y el extasis', count: 2 },
    { date: '2026-11-09', query: '9788499809991', count: 1 },
    { date: '2026-11-10', query: 'biblia reina valera', count: 1 },
    { date: '2026-11-10', query: 'desarrollo personal y autoayuda', count: 15 },
    { date: '2026-11-10', query: 'psicologia y pedagogia psicologia psicologia basica', count: 8 },
];
const items = [
    { bibliographic: { genre: 'Desarrollo personal y autoayuda' } },
    { bibliographic: { genre: 'Psicología y pedagogía > Psicología > Psicología básica' } },
];

test('los géneros y categorías del propio sitio se reconocen, con y sin recorrido completo', () => {
    const generos = generosNormalizados(items, { categories: [{ name: 'Humanidades', subcategories: [{ name: 'Crítica literaria' }] }] });
    assert.ok(generos.has('desarrollo personal y autoayuda'));
    assert.ok(generos.has('psicologia y pedagogia psicologia psicologia basica'));
    assert.ok(generos.has('psicologia basica'));
    assert.ok(generos.has('humanidades') && generos.has('critica literaria'));
});

test('se descartan pruebas, géneros del sitio y filas inválidas', () => {
    const generos = generosNormalizados(items);
    const limpias = limpiar([...filas, { date: '2026-11-10', query: '', count: 5 }, { date: '2026-11-10', query: 'x', count: 0 }, { date: '2026-11-10', query: 'search term string', count: 7 }], { generos });
    const textos = limpias.map(f => f.query);
    assert.ok(!textos.includes('zzzinexistente999'));
    assert.ok(!textos.includes('desarrollo personal y autoayuda'));
    assert.ok(!textos.includes('psicologia y pedagogia psicologia psicologia basica'));
    assert.ok(!textos.includes('search term string'));
    assert.ok(textos.includes('tarot de marsella') && textos.includes('la agonia y el extasis'));
    assert.equal(limpias.length, 6);
});

test('resumen: por texto, por semana (lunes) y por tema', () => {
    const r = resumir(limpiar(filas, { generos: generosNormalizados(items) }));
    assert.equal(r.textos[0].query, 'tarot de marsella');
    assert.equal(r.textos[0].veces, 5);
    assert.equal(r.textos[0].dias.size, 2);
    assert.deepEqual(r.semanas.map(s => [s.semana, s.veces]), [['2026-11-02', 5], ['2026-11-09', 5]]);
    assert.equal(r.temas.find(t => t.nombre.startsWith('Tarot')).veces, 5);
    assert.ok(r.temas.some(t => t.nombre.startsWith('Biblias')));
    assert.equal(r.isbn.length, 1);
    assert.ok(TEMAS.length >= 8);
});

test('el listado trae pedidos del formulario, avisos de stock y búsquedas, sin datos personales', () => {
    const pedidos = [{ created_at: '2026-11-05T10:00:00Z', request_type: 'agotado', query: 'Rayuela, primera edición', author_isbn: 'Cortázar', format: 'Libro físico', language: 'Español', budget_uyu: 1800 }];
    const avisos = [
        { product_id: 'MLU1', product_title: 'Biblia de Navarra', created_at: '2026-11-04T10:00:00Z', email: 'secreto@x.com' },
        { product_id: 'MLU1', product_title: 'Biblia de Navarra', created_at: '2026-11-06T10:00:00Z', email: 'otro@x.com' },
    ];
    const md = aMarkdown(limpiar(filas, { generos: generosNormalizados(items) }), { generado: new Date('2026-11-12T00:00:00Z'), pedidos, avisos, descartadas: 63 });
    assert.match(md, /Pedidos con el formulario «Pedir un libro»: \*\*1\*\*/);
    assert.match(md, /\| 2026-11-05 \| agotado \| Rayuela, primera edición \| Cortázar \| Libro físico \| Español \| \$1800 \|/);
    assert.match(md, /\| Biblia de Navarra \| 2 \| 2026-11-06 \|/);
    assert.match(md, /Ya se descartaron 63 búsquedas/);
    assert.match(md, /\| tarot de marsella \| 5 \| 2 \|/);
    assert.match(md, /- biblia reina valera/);
    assert.doesNotMatch(md, /zzzinexistente999|desarrollo personal y autoayuda|secreto@x\.com|otro@x\.com/);
});

test('sin pedidos ni avisos el listado lo dice y no falla', () => {
    const md = aMarkdown([]);
    assert.match(md, /Sin pedidos registrados/);
    assert.match(md, /Sin avisos/);
});

test('el workflow es manual, de solo lectura y no imprime el listado en el log público', () => {
    const wf = readFileSync('.github/workflows/busquedas-export.yml', 'utf8');
    assert.match(wf, /^on:\n  workflow_dispatch:\n/m);
    assert.match(wf, /permissions:\n  contents: read/);
    assert.doesNotMatch(wf, /pull_request|push:|contents: write|GITHUB_STEP_SUMMARY|cat artifacts/);
    assert.match(wf, /REPORT_EMAIL_TO: undiaes@gmail\.com\n/);
    assert.match(wf, /lo-que-pidieron-clientes\.md/);
    const script = readFileSync('scripts/ops/busquedas-export.mjs', 'utf8');
    assert.doesNotMatch(script, /SELECT[^`']*\b(email|phone|telefono|ip_hash)\b/i, 'no se leen datos personales');
    assert.doesNotMatch(script, /console\.log\([^)]*(md|pedidos\.map|avisos\.map|filas\.map)/);
});
