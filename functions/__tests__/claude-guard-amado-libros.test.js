import test from 'node:test';
import assert from 'node:assert/strict';
import {decide} from '../../.claude/hooks/guard-amado-libros.mjs';

const edit = (file_path, new_string = 'x') => ({tool_name: 'Edit', tool_input: {file_path, new_string}});
const shell = (tool_name, command) => ({tool_name, tool_input: {command}});

test('pide permiso antes de editar código propio de Amado Libros, con ruta de Windows o POSIX', () => {
  assert.match(decide(edit('C:\\Users\\cgnso\\amadolibros-x\\worker-sync\\publication-queue.js')), /código de Amado Libros/);
  assert.match(decide(edit('/c/repo/.github/workflows/mercadolibre-publication-queue.yml')), /código de Amado Libros/);
  assert.match(decide({tool_name: 'Write', tool_input: {file_path: '/c/repo/scripts/mercadolibre/publisher-control.mjs', content: 'x'}}), /código de Amado Libros/);
});

test('avisa que un archivo compartido con Vintage también cambia Amado Libros', () => {
  assert.match(decide(edit('C:\\repo\\worker-sync\\publication-engine.js')), /comparten Amado Libros y Vintage/);
  assert.match(decide(edit('/c/repo/worker-sync/publication-policy.js')), /comparten/);
});

test('frena cualquier cambio o comando que mencione el seller o la cola de Amado Libros', () => {
  assert.match(decide({tool_name: 'Write', tool_input: {file_path: '/c/repo/docs/nota.md', content: 'seller 440298103'}}), /440298103/);
  assert.match(decide({tool_name: 'MultiEdit', tool_input: {file_path: '/c/repo/x.js', edits: [{new_string: "const s='440298103'"}]}}), /440298103/);
  assert.ok(decide(shell('Bash', 'gh workflow run mercadolibre-publication-queue.yml')));
  assert.ok(decide(shell('PowerShell', 'node scripts/mercadolibre/publisher-control.mjs --action pause')));
  assert.ok(decide(shell('Bash', 'curl https://api.mercadolibre.com/users/440298103/items/search')));
});

test('deja pasar el trabajo de Vintage, la lectura y los comandos comunes', () => {
  assert.equal(decide(edit('/c/repo/scripts/vintage-local/engine.mjs')), null);
  assert.equal(decide(edit('C:\\repo\\functions\\_shared\\vintage-local-access.js')), null);
  assert.equal(decide({tool_name: 'Read', tool_input: {file_path: '/c/repo/worker-sync/publication-queue.js'}}), null);
  assert.equal(decide({tool_name: 'Grep', tool_input: {pattern: '440298103'}}), null);
  assert.equal(decide(shell('Bash', 'git status')), null);
  assert.equal(decide(shell('PowerShell', 'node --test functions/__tests__/vintage-renew.test.js')), null);
});
