import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// El sync completo supera los 30.000 ms de CPU por defecto y Cloudflare lo corta
// con error 1102. Este guard evita volver al límite por defecto sin querer.
const WORKERS_PAID_MAX_CPU_MS = 300000;

function readWranglerToml() {
  const workerRoot = fileURLToPath(new URL('../', import.meta.url));
  return readFileSync(`${workerRoot}/wrangler.toml`, 'utf8');
}

function tomlSection(source, header) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.trim() === `[${header}]`);
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

test('worker-sync/wrangler.toml declara [limits] cpu_ms en el máximo de Workers Paid', () => {
  const wrangler = readWranglerToml();
  const limits = tomlSection(wrangler, 'limits');
  assert.ok(limits, 'falta la sección [limits] en worker-sync/wrangler.toml');
  const match = limits.match(/^\s*cpu_ms\s*=\s*(\d+)\s*(?:#.*)?$/m);
  assert.ok(match, 'falta cpu_ms dentro de [limits]');
  assert.equal(Number(match[1]), WORKERS_PAID_MAX_CPU_MS);
});

test('[limits] aparece una sola vez y antes de cualquier entorno', () => {
  const wrangler = readWranglerToml();
  assert.equal((wrangler.match(/^\s*\[limits\]\s*$/gm) || []).length, 1);
  // Un [env.*] posterior sin limits heredaría el valor por defecto de 30.000 ms.
  assert.ok(!/^\s*\[env\./m.test(wrangler), 'si se agregan entornos, cada uno debe repetir [env.<nombre>.limits]');
});
