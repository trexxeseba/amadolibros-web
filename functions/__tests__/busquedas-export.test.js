import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { limpiar, resumir, aMarkdown, aCsv, TEMAS } from '../../scripts/ops/busquedas-export.mjs';

const filas = [
    { date: '2026-11-02', query: 'zzzinexistente999', count: 40 },
    { date: '2026-11-02', query: 'tarot de marsella', count: 3 },
    { date: '2026-11-03', query: 'tarot de marsella', count: 2 },
    { date: '2026-11-09', query: 'psicologia infantil', count: 1 },
    { date: '2026-11-09', query: 'la agonia y el extasis', count: 2 },
    { date: '2026-11-09', query: '9788499809991', count: 1 },
    { date: '2026-11-10', query: 'biblia reina valera', count: 1 },
];

test('se descartan las búsquedas de prueba y las filas inválidas', () => {
    const limpias = limpiar([...filas, { date: '2026-11-10', query: '', count: 5 }, { date: '2026-11-10', query: 'x', count: 0 }]);
    assert.ok(!limpias.some(f => f.query === 'zzzinexistente999'));
    assert.equal(limpias.length, 6);
});

test('resumen: por texto, por semana (lunes) y por tema', () => {
    const r = resumir(limpiar(filas));
    assert.equal(r.textos[0].query, 'tarot de marsella');
    assert.equal(r.textos[0].veces, 5);
    assert.equal(r.textos[0].dias.size, 2);
    assert.deepEqual(r.semanas.map(s => [s.semana, s.veces]), [['2026-11-02', 5], ['2026-11-09', 5]]);
    const tarot = r.temas.find(t => t.nombre.startsWith('Tarot'));
    assert.equal(tarot.veces, 5);
    assert.ok(r.temas.some(t => t.nombre.startsWith('Psicolog')));
    assert.ok(r.temas.some(t => t.nombre.startsWith('Biblias')));
    assert.equal(r.isbn.length, 1);
    assert.ok(TEMAS.length >= 8);
});

test('el informe en markdown trae totales, semanas, temas y buscados una vez', () => {
    const md = aMarkdown(limpiar(filas), { generado: new Date('2026-11-12T00:00:00Z') });
    assert.match(md, /Búsquedas sin resultados: \*\*10\*\*/);
    assert.match(md, /\| 2026-11-02 \| 5 \| 1 \|/);
    assert.match(md, /Lo más buscado/);
    assert.match(md, /\| tarot de marsella \| 5 \| 2 \|/);
    assert.match(md, /- biblia reina valera/);
    assert.doesNotMatch(md, /zzzinexistente999/);
    assert.match(md, /Sin IP, sesión ni datos personales/);
});

test('el CSV escapa comillas y trae una fila por texto', () => {
    const csv = aCsv(limpiar([{ date: '2026-11-02', query: 'libro "raro"', count: 2 }]));
    assert.equal(csv.split('\n')[0], 'busqueda,veces,dias,primera_vez,ultima_vez');
    assert.match(csv, /"libro ""raro""",2,1,2026-11-02,2026-11-02/);
});

test('el workflow es manual, de solo lectura y no imprime el informe en el log público', () => {
    const wf = readFileSync('.github/workflows/busquedas-export.yml', 'utf8');
    assert.match(wf, /^on:\n  workflow_dispatch:\n/m);
    assert.match(wf, /permissions:\n  contents: read/);
    assert.doesNotMatch(wf, /pull_request|push:|contents: write|GITHUB_STEP_SUMMARY|cat artifacts/);
    assert.match(wf, /REPORT_EMAIL_TO: undiaes@gmail\.com\n/);
    const script = readFileSync('scripts/ops/busquedas-export.mjs', 'utf8');
    assert.doesNotMatch(script, /console\.log\([^)]*(md|csv|filas\.map)/);
});
