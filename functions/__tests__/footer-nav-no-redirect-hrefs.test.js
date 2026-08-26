// AUDITORIA-EXTERNA-25AGO2026, Bloque 3.
//
// Las nueve paginas estaticas se emiten como dist/<ruta>/index.html. La
// comprobacion HTTP de Produccion confirmo que /ruta responde 308 y /ruta/
// responde 200. Por eso la variante con barra es la unica URL que deben usar
// la navegacion, el canonical y sitemap-pages.xml.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIC_SITEMAP_PAGES } from '../sitemap-pages.xml.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const STATIC_ROUTES = Object.freeze([
  'como-identificar-edicion-correcta-isbn',
  'contacto',
  'devoluciones',
  'envios',
  'pedir-libro',
  'privacidad',
  'quienes-somos',
  'terminos',
  'politicas',
]);

const STATIC_PAGE_SOURCES = Object.freeze(
  Object.fromEntries(STATIC_ROUTES.map(route => [route, `astro-front/src/pages/${route}.astro`])),
);

function sourceFiles(root, ignored = new Set()) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    const relative = path.relative(repoRoot, absolute).replaceAll('\\', '/');
    if (ignored.has(relative) || relative.includes('/__tests__/')) continue;
    if (entry.isDirectory()) files.push(...sourceFiles(absolute, ignored));
    else if (/\.(?:astro|js)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

function hrefTargets(source) {
  const targets = [];
  for (const match of source.matchAll(/\bhref\s*(?:=|:)\s*\{?\s*(["'`])([^"'`]+)\1/g)) {
    targets.push(match[2]);
  }
  return targets;
}

function slashlessStaticRoute(target) {
  const internal = target.replace(/^https:\/\/www\.amadolibros\.com/, '');
  if (!internal.startsWith('/') || internal.startsWith('//')) return null;
  const pathname = internal.split(/[?#]/, 1)[0];
  return STATIC_ROUTES.find(route => pathname === `/${route}`) || null;
}

test('navegacion desplegable fuera del checkout apunta directo a las nueve rutas finales', () => {
  const ignored = new Set([
    // Restriccion vinculante del frente: no tocar checkout. Sus seis href
    // legales slashless quedan registrados en el test siguiente.
    'astro-front/src/pages/carrito.astro',
  ]);
  const files = [
    ...sourceFiles(path.join(repoRoot, 'astro-front', 'src'), ignored),
    ...sourceFiles(path.join(repoRoot, 'functions'), ignored),
  ];
  const findings = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const target of hrefTargets(source)) {
      const route = slashlessStaticRoute(target);
      if (route) findings.push(`${path.relative(repoRoot, file)}: ${target}`);
    }
  }
  assert.deepEqual(findings, [], `hrefs que todavia producirian 308:\n  ${findings.join('\n  ')}`);

  // Este enlace se construye primero como variable y despues se inserta en
  // href. Se valida aparte porque el extractor ve la variable.
  assert.match(
    readFileSync(path.join(repoRoot, 'functions/especialidades/[[path]].js'), 'utf8'),
    /const requestPath = `\/pedir-libro\/\?tipo=/,
  );
});

test('los seis href legales del carrito quedan como residual explicito y acotado', () => {
  const cart = readFileSync(path.join(repoRoot, 'astro-front/src/pages/carrito.astro'), 'utf8');
  const residual = hrefTargets(cart).filter(target => slashlessStaticRoute(target));
  assert.deepEqual(residual, [
    '/terminos', '/envios', '/devoluciones',
    '/terminos', '/envios', '/devoluciones',
  ]);
});

test('canonical y sitemap usan la misma variante final con barra', () => {
  for (const route of STATIC_ROUTES) {
    const expected = `https://www.amadolibros.com/${route}/`;
    const page = readFileSync(path.join(repoRoot, STATIC_PAGE_SOURCES[route]), 'utf8');
    assert.ok(page.includes(expected), `canonical de ${route} no usa ${expected}`);
    assert.ok(STATIC_SITEMAP_PAGES.includes(expected), `sitemap sin ${expected}`);
    assert.ok(!STATIC_SITEMAP_PAGES.includes(expected.slice(0, -1)), `sitemap conserva variante 308: ${route}`);
  }
  const config = readFileSync(path.join(repoRoot, 'astro-front/astro.config.mjs'), 'utf8');
  assert.match(config, /trailingSlash:\s*'always'/);
});

test('el build emite directorios y canonicals con barra para las nueve rutas', () => {
  const distDir = path.join(repoRoot, 'astro-front', 'dist');
  let existeDist = false;
  try { existeDist = statSync(distDir).isDirectory(); } catch { /* build aun no ejecutado */ }
  if (!existeDist) return;

  for (const route of STATIC_ROUTES) {
    const indexPath = path.join(distDir, route, 'index.html');
    assert.ok(statSync(indexPath).isFile(), `falta dist/${route}/index.html`);
    const html = readFileSync(indexPath, 'utf8');
    assert.match(html, new RegExp(`<link rel="canonical" href="https://www\\.amadolibros\\.com/${route}/">`));
  }
});
