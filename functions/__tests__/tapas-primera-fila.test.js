import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// En celular las tapas de más abajo compiten por la red con el primer pintado.
// Sólo la primera fila (hasta 4) se pide sin espera; el resto, al acercarse.
const REGLAS = {
  'functions/catalogo.js': /idx < 4 \? 'eager' : 'lazy'/,
  'functions/libros/[[path]].js': /const eager = index < 4;/,
  'functions/libros-por-encargo.js': /position < 4 \? 'eager' : 'lazy'/,
  'functions/liquidacion.js': /idx < 4 \? 'eager' : 'lazy'/,
  'functions/regalos.js': /idx < 4 \? 'eager' : 'lazy'/,
};

test('los listados piden sin espera solamente la primera fila de tapas', () => {
  for (const [archivo, regla] of Object.entries(REGLAS)) {
    assert.match(fs.readFileSync(archivo, 'utf8'), regla, archivo);
  }
});
