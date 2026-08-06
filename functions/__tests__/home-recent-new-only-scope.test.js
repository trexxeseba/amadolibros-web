// HOME-RECENT-NEW-ONLY: el filtro "solo nuevos" es exclusivo de
// "Incorporaciones recientes" (home.json / BestsellerSection). Este test
// es un control de alcance — confirma que /catalogo, la ficha de producto
// y el feed de Merchant Center siguen sin excluir usados, y no importan
// el módulo nuevo de selección de recientes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = p => readFileSync(path.join(root, p), 'utf8');

test('functions/catalogo.js no filtra por condition (activas/pausadas de cualquier condición siguen visibles)', () => {
  const src = read('functions/catalogo.js');
  assert.doesNotMatch(src, /condition\s*===?\s*['"]new['"]/);
  assert.doesNotMatch(src, /pick-recent-books/);
});

test('functions/libro/[[path]].js solo usa `condition` para mostrarla, nunca para excluir la ficha', () => {
  const src = read('functions/libro/[[path]].js');
  assert.doesNotMatch(src, /condition\s*!==?\s*['"]used['"]/);
  assert.doesNotMatch(src, /condition\s*===?\s*['"]new['"]\s*&&/);
});

test('functions/feed.xml.js sigue incluyendo ítems usados en el feed (con su <g:condition> correspondiente, no excluidos)', () => {
  const src = read('functions/feed.xml.js');
  // SEO-GMC-FEED-1: la descripción del feed distingue "Ejemplar nuevo."/
  // "Ejemplar usado." por texto (item.condition === 'new'/'used'), sin
  // excluir nada — igual que libro/[[path]].js (línea de abajo), el
  // patrón prohibido es específicamente un filtro exclusorio
  // (`condition === 'new' && <algo que corta la lista>`), no cualquier
  // lectura de `condition` para mostrarla.
  assert.doesNotMatch(src, /condition\s*===?\s*['"]new['"]\s*&&/);
  assert.doesNotMatch(src, /\.filter\([^)]*condition/);
  assert.match(src, /g:condition/);
});
