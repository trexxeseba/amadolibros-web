import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeCategoryPaths } from '../_shared/category-paths.js';

const dataPath = fileURLToPath(new URL('../../astro-front/public/data/active-categories.json', import.meta.url));
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const religion = data.categories.find(category => category.id === 'religion-espiritualidad');
const subcategory = id => religion?.subcategories?.find(entry => entry.id === id);
const tagsFor = id => normalizeCategoryPaths(data.items[id]).flat();
const idsWith = tag => Object.entries(data.items)
    .filter(([, paths]) => normalizeCategoryPaths(paths).flat().includes(tag))
    .map(([id]) => id);

test('el artefacto publicado conserva Biblia y Reina-Valera como clasificaciones distintas', () => {
    assert.ok(religion, 'falta la categoría religion-espiritualidad');
    assert.ok(subcategory('biblia'), 'falta la subcategoría Biblia');
    assert.ok(subcategory('reina-valera'), 'falta la subcategoría Reina-Valera');
    assert.equal(idsWith('biblia').length, subcategory('biblia').count);
    assert.equal(idsWith('reina-valera').length, subcategory('reina-valera').count);
});

test('todo elemento bíblico pertenece a Religión y ninguna Reina-Valera queda duplicada como Biblia genérica', () => {
    for (const id of [...idsWith('biblia'), ...idsWith('reina-valera')]) {
        assert.ok(tagsFor(id).includes('religion-espiritualidad'), id);
    }
    const overlap = idsWith('reina-valera').filter(id => tagsFor(id).includes('biblia'));
    assert.deepEqual(overlap, []);
});

test('casos comerciales conocidos sostienen las dos intenciones de landing', () => {
    assert.deepEqual(tagsFor('MLU610980536'), ['religion-espiritualidad', 'biblia']);
    assert.deepEqual(tagsFor('MLU623339357'), ['religion-espiritualidad', 'reina-valera']);
});

test('falsos positivos de Religión no contaminan las landings bíblicas', () => {
    const ids = [
        // Fuera de Religión por QA general.
        'MLU652656116', 'MLU625778990', 'MLU628782805',
        // BIBLES-RVR-GROWTH-1: obras sobre la Biblia, atlas, cursos,
        // devocionales y evangelios no canónicos; no son ediciones bíblicas.
        'MLU620933524', 'MLU632116117',
        'MLU680701220',
        'MLU683276890', 'MLU683328768',
        'MLU683303056', 'MLU683315786',
        'MLU641395963', 'MLU728898818',
        'MLU641505355', 'MLU641492655',
        'MLU692178266',
        'MLU644976277',
        'MLU721417672', 'MLU650445257',
        'MLU728992876', 'MLU729005860',
        'MLU1034177554',
        'MLU1225098844', 'MLU1317659918',
    ];
    for (const id of ids) {
        assert.ok(!tagsFor(id).includes('biblia'), id);
        assert.ok(!tagsFor(id).includes('reina-valera'), id);
    }
});
