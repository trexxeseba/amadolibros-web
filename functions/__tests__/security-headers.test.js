// AUDITORIA-EXTERNA-25AGO2026, Bloque 4 (Lote 3 del brief).
//
// Screaming Frog reporto ausencia de HSTS/X-Frame-Options/Referrer-Policy en
// 382/381/369 URLs. Este test fija el contrato minimo sobre
// astro-front/public/_headers, el archivo que Astro copia a dist/_headers y
// que Cloudflare Pages efectivamente lee (verificado corriendo `npm run
// build` y comparando dist/_headers contra este archivo: son identicos).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HEADERS_PATH = fileURLToPath(new URL('../../astro-front/public/_headers', import.meta.url));
const content = readFileSync(HEADERS_PATH, 'utf8');

test('los tres encabezados de seguridad estan presentes bajo la regla global /*', () => {
  assert.match(content, /^\/\*$/m, 'falta la regla global /*');
  assert.match(content, /Strict-Transport-Security:\s*max-age=31536000;\s*includeSubDomains/);
  assert.match(content, /X-Frame-Options:\s*SAMEORIGIN/);
  assert.match(content, /Referrer-Policy:\s*strict-origin-when-cross-origin/);
});

test('HSTS no lleva preload — el brief lo prohibe explicitamente', () => {
  assert.doesNotMatch(content, /Strict-Transport-Security:[^\n]*preload/i);
});

test('no se agrega Content-Security-Policy en este Bloque', () => {
  // El brief pide entregar solo el inventario de origenes (en el informe) y
  // desplegar CSP en Report-Only recien despues, con datos. Escribirla aca
  // seria hacerlo a ciegas.
  //
  // Se ignoran las lineas de comentario (que SI mencionan la directiva por
  // nombre, para explicar por que no esta): se busca una linea de directiva
  // real, con dos espacios de indentacion como el resto de las reglas de
  // este archivo, nunca una linea que empiece con '#'.
  const lineasDeDirectiva = content.split('\n').filter(line => !line.trim().startsWith('#'));
  assert.doesNotMatch(lineasDeDirectiva.join('\n'), /Content-Security-Policy\s*:/i);
});

test('las reglas previas del archivo (historial del incidente de robots/no-store) siguen documentadas', () => {
  assert.match(content, /No agregar reglas de robots\/caché en este archivo/);
});
