import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('PERF-H1 elimina la hoja externa bloqueante y precarga la fuente del LCP', async () => {
  const layout = await read('../../layouts/BaseLayout.astro');

  assert.doesNotMatch(layout, /fonts\.bunny\.net/);
  assert.match(layout, /playfair-display-latin-700-normal\.woff2\?url/);
  assert.match(layout, /rel="preload"[^>]+as="font"[^>]+type="font\/woff2"/);
  assert.match(layout, /font-display:\s*swap/);
});

test('PERF-H1 embebe el CSS pequeño para sacarlo de la ruta crítica', async () => {
  const config = await read('../../../astro.config.mjs');

  assert.match(config, /inlineStylesheets:\s*'always'/);
});

test('PERF-H1 usa un logo de cabecera liviano y conserva dimensiones fijas', async () => {
  const header = await read('../../components/Header.astro');
  const logoUrl = new URL('../../../public/images/logo-amado-header.webp', import.meta.url);
  const logo = await stat(logoUrl);

  assert.match(header, /src="\/images\/logo-amado-header\.webp"/);
  assert.match(header, /width="58"\s+height="57"/);
  assert.ok(logo.size <= 5_000, `el logo pesa ${logo.size} bytes`);
});
