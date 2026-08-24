import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dataPath = fileURLToPath(new URL('../../astro-front/public/data/active-categories.json', import.meta.url));
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const religion = data.categories.find(category => category.id === 'religion-espiritualidad');
const subcategory = id => religion?.subcategories?.find(entry => entry.id === id);
const tagsFor = id => data.items[id] || [];
const idsWith = tag => Object.entries(data.items)
    .filter(([, tags]) => tags.includes(tag))
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
    for (const id of ['MLU652656116', 'MLU625778990', 'MLU628782805']) {
        assert.ok(!tagsFor(id).includes('biblia'), id);
        assert.ok(!tagsFor(id).includes('reina-valera'), id);
    }
});
