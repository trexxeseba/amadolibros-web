import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fixMojibake,
  hasIrreversibleDataLoss,
  hasMojibakeSignal,
} from '../_shared/mojibake.js';

// ── Casos obligatorios del reporte ──────────────────────────────────────

test('repara SuperniÃ±a -> Superniña', () => {
  assert.equal(fixMojibake('SuperniÃ±a'), 'Superniña');
});

test('repara CÃ­rculo -> Círculo dentro de un título completo', () => {
  assert.equal(
    fixMojibake('Del CÃ­rculo Que Se CayÃ³ De Una Camiseta De Lunares'),
    'Del Círculo Que Se Cayó De Una Camiseta De Lunares',
  );
});

test('repara CayÃ³ -> Cayó', () => {
  assert.equal(fixMojibake('CayÃ³'), 'Cayó');
});

test('repara JesÃºs -> Jesús', () => {
  assert.equal(fixMojibake('JesÃºs'), 'Jesús');
});

test('repara ediciÃ³n -> edición', () => {
  assert.equal(fixMojibake('ediciÃ³n'), 'edición');
});

// ── Controles negativos: texto Unicode correcto queda intacto ──────────

test('no toca palabras con acentos ya correctos', () => {
  for (const text of [
    'niña',
    'Círculo',
    'Jesús',
    'Cien años de soledad',
    'José María Ñúñez',
    'edición',
    'último',
    'público',
  ]) {
    assert.equal(fixMojibake(text), text, `no debería cambiar: ${text}`);
  }
});

test('no toca títulos con caracteres extranjeros legítimos', () => {
  for (const text of [
    'Über todo: relatos',
    'Café con leche',
    'François y el mar',
    'Naïve: una historia',
    '¡Hola! ¿Qué tal?',
    'Ella dijo "hola" y ‘hola’ de nuevo',
  ]) {
    assert.equal(fixMojibake(text), text, `no debería cambiar: ${text}`);
  }
});

test('no toca texto vacío, nulo o no-string', () => {
  assert.equal(fixMojibake(''), '');
  assert.equal(fixMojibake(null), '');
  assert.equal(fixMojibake(undefined), '');
  assert.equal(fixMojibake(123), '123');
});

// ── Idempotencia ─────────────────────────────────────────────────────────

test('es idempotente: aplicarla dos veces da el mismo resultado', () => {
  const cases = [
    'SuperniÃ±a',
    'Del CÃ­rculo Que Se CayÃ³ De Una Camiseta De Lunares',
    'niña',
    'Cien años de soledad',
    'texto sin ningún problema',
  ];
  for (const text of cases) {
    const once = fixMojibake(text);
    const twice = fixMojibake(once);
    assert.equal(twice, once, `no idempotente para: ${text}`);
  }
});

// ── Nunca introduce el carácter de reemplazo ────────────────────────────

test('nunca introduce el carácter de reemplazo Unicode', () => {
  const cases = [
    'SuperniÃ±a',
    'texto normal',
    'Ã©Ã¨Ã Ã¹Ã¬Ã²', // corrida larga de vocales mal codificadas
    '￿￾', // codepoints fuera de rango, no deberían romper nada
  ];
  for (const text of cases) {
    assert.equal(fixMojibake(text).includes('�'), false, `introdujo \\uFFFD para: ${text}`);
  }
});

test('si el texto ya perdió datos (contiene el carácter de reemplazo), lo deja intacto', () => {
  const lossy = 'Historia � incompleta';
  assert.equal(fixMojibake(lossy), lossy);
});

// ── Múltiples corridas en un mismo texto ────────────────────────────────

test('repara varias corridas de mojibake en el mismo texto', () => {
  assert.equal(fixMojibake('SuperniÃ±a y JesÃºs, ediciÃ³n especial'), 'Superniña y Jesús, edición especial');
});

// ── Emoji / secuencias UTF-8 de más de 2 bytes ──────────────────────────

test('repara mojibake de emoji (secuencias UTF-8 de 4 bytes)', () => {
  // "🎉" (U+1F389) re-interpretado byte a byte como Windows-1252 produce "ðŸŽ‰".
  assert.equal(fixMojibake('Novedad ðŸŽ‰ de la semana'), 'Novedad 🎉 de la semana');
});

// ── hasMojibakeSignal / hasIrreversibleDataLoss (medición y reportes) ──

test('hasMojibakeSignal detecta los patrones típicos, no falsos positivos en texto sano', () => {
  assert.equal(hasMojibakeSignal('SuperniÃ±a'), true);
  assert.equal(hasMojibakeSignal('Novedad ðŸŽ‰'), true);
  assert.equal(hasMojibakeSignal('Historia � incompleta'), true);
  assert.equal(hasMojibakeSignal('niña'), false);
  assert.equal(hasMojibakeSignal('Cien años de soledad'), false);
});

test('hasIrreversibleDataLoss sólo detecta el carácter de reemplazo Unicode', () => {
  assert.equal(hasIrreversibleDataLoss('Historia � incompleta'), true);
  assert.equal(hasIrreversibleDataLoss('SuperniÃ±a'), false);
  assert.equal(hasIrreversibleDataLoss('niña'), false);
});
