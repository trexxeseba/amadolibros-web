// Recursos que bloqueaban el primer pintado en móvil (Lighthouse):
// - la hoja de fuentes de fonts.bunny.net → fuentes propias en /fonts/;
// - /whatsapp-messages.js sincrónico → con defer en todas las plantillas.
// Estas pruebas impiden volver a cualquiera de los dos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_FONT_FILES, SITE_FONTS_HEAD } from '../../shared/site-fonts.js';
import { SITE_FONTS_HEAD as HEADER_FONTS_HEAD } from '../_shared/site-header.js';
import { faviconHeadHtml } from '../_shared/brand.js';
import { onRequest as middlewareRequest } from '../_middleware.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FONTS_DIR = join(ROOT, 'astro-front/public/fonts');
const SCANNED_DIRS = ['astro-front/src', 'astro-front/public', 'functions', 'shared'];
const SCANNED_EXT = new Set(['.js', '.mjs', '.ts', '.astro', '.html', '.css']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCANNED_EXT.has(extname(name))) out.push(full);
  }
  return out;
}

const sources = SCANNED_DIRS.flatMap(dir => walk(join(ROOT, dir)))
  .map(file => ({ file: relative(ROOT, file), text: readFileSync(file, 'utf8') }));

test('ninguna plantilla pide fuentes a un CDN externo', () => {
  const external = /fonts\.(?:bunny\.net|googleapis\.com|gstatic\.com)|use\.typekit\.net/;
  const offenders = sources.filter(({ text }) => external.test(text)).map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test('/whatsapp-messages.js se carga siempre con defer', () => {
  const tag = /<script\b[^>]*\bsrc=["']\/whatsapp-messages\.js["'][^>]*>/g;
  let found = 0;
  for (const { file, text } of sources) {
    for (const match of text.matchAll(tag)) {
      found += 1;
      assert.match(match[0], /\bdefer\b/, `${file}: ${match[0]}`);
    }
  }
  assert.ok(found >= 2, 'se esperaban al menos BaseLayout.astro y brand.js');
  assert.match(faviconHeadHtml(), /<script src="\/whatsapp-messages\.js" defer><\/script>/);
});

test('las fuentes propias existen, son woff2 y el nombre lleva su hash', () => {
  for (const font of SITE_FONT_FILES) {
    const path = join(ROOT, 'astro-front/public', font.file);
    assert.ok(existsSync(path), font.file);
    const bytes = readFileSync(path);
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', font.file);
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
    assert.ok(font.file.endsWith(`.${hash}.woff2`), `${font.file} debería terminar en .${hash}.woff2`);
  }
  const listed = new Set(SITE_FONT_FILES.map(font => font.file.replace('/fonts/', '')));
  const onDisk = readdirSync(FONTS_DIR).filter(name => name.endsWith('.woff2'));
  assert.deepEqual(onDisk.filter(name => !listed.has(name)), [], 'woff2 sin usar en public/fonts');
});

test('el bloque de fuentes precarga a lo sumo dos y declara font-display swap', () => {
  const preloads = SITE_FONTS_HEAD.match(/<link rel="preload"[^>]*>/g) || [];
  assert.ok(preloads.length >= 1 && preloads.length <= 2);
  for (const link of preloads) {
    assert.match(link, /as="font"/);
    assert.match(link, /type="font\/woff2"/);
    assert.match(link, /crossorigin/);
  }
  assert.equal((SITE_FONTS_HEAD.match(/@font-face/g) || []).length, SITE_FONT_FILES.length);
  assert.equal((SITE_FONTS_HEAD.match(/font-display:swap/g) || []).length, SITE_FONT_FILES.length);
  assert.equal(HEADER_FONTS_HEAD, SITE_FONTS_HEAD, 'las Functions usan el mismo bloque que Astro');
});

test('cada familia y peso tiene latin (precargable) y latin-ext (nunca precargado)', () => {
  const key = font => `${font.family} ${font.weight}`;
  const latin = SITE_FONT_FILES.filter(font => font.subset === 'latin').map(key).sort();
  const ext = SITE_FONT_FILES.filter(font => font.subset === 'latin-ext');
  assert.deepEqual(ext.map(key).sort(), latin);
  for (const font of ext) {
    assert.equal(font.preload, false, font.file);
    assert.ok(!SITE_FONTS_HEAD.includes(`<link rel="preload" href="${font.file}"`), font.file);
  }
  assert.match(SITE_FONTS_HEAD, /unicode-range:U\+0100-02BA/);
});

test('las fuentes con hash se sirven con caché larga en Preview y Producción', async () => {
  const font = SITE_FONT_FILES[0].file;
  for (const origin of ['https://pr-1.amadolibros-web.pages.dev', 'https://www.amadolibros.com']) {
    const response = await middlewareRequest({
      request: new Request(origin + font),
      async next() { return new Response('font'); },
    });
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable', origin);
  }
  const unhashed = await middlewareRequest({
    request: new Request('https://pr-1.amadolibros-web.pages.dev/fonts/otra.woff2'),
    async next() { return new Response('font'); },
  });
  assert.equal(unhashed.headers.get('cache-control'), 'no-store');
});
