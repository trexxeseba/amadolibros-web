// scripts/ux/capture-screens.mjs
//
// Capturas de la web en producción (celular y compu) para revisar la
// experiencia de compra página por página. Solo lectura: navega como un
// visitante, no agrega al carrito ni envía formularios.
//
// Uso: node scripts/ux/capture-screens.mjs [baseUrl]

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'https://www.amadolibros.com';
const OUT = path.join('artifacts', 'ux-audit', 'capturas');
const VIEWPORTS = [
  { name: 'movil', width: 390, height: 844, isMobile: true },
  { name: 'compu', width: 1366, height: 900, isMobile: false },
];

async function sampleUrls() {
  const pages = [
    ['portada', '/'],
    ['catalogo', '/catalogo'],
    ['catalogo-historia', '/catalogo?categoria=historia'],
    ['busqueda', '/catalogo?q=harry+potter'],
    ['busqueda-sin-resultados', '/catalogo?q=zzzqqq'],
    ['temas', '/temas'],
    ['landing-psicologia', '/libros/psicologia'],
    ['pedir-libro', '/pedir-libro/'],
    ['carrito', '/carrito'],
    ['agotados', '/libros-agotados-importados-uruguay'],
  ];
  try {
    const xml = await (await fetch(`${BASE}/sitemap-books-active.xml`)).text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    const picks = [locs[3], locs[Math.floor(locs.length / 2)]].filter(Boolean);
    picks.forEach((loc, i) => pages.push([`ficha-${i + 1}`, new URL(loc).pathname]));
  } catch (error) {
    console.warn('No se pudo leer el sitemap de fichas:', error.message);
  }
  return pages;
}

const pages = await sampleUrls();
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const report = [];
for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.isMobile,
    hasTouch: vp.isMobile,
    deviceScaleFactor: vp.isMobile ? 2 : 1,
    locale: 'es-UY',
  });
  for (const [name, route] of pages) {
    const page = await context.newPage();
    const started = Date.now();
    let status = 0;
    try {
      const response = await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 45000 });
      status = response?.status() || 0;
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(OUT, `${vp.name}-${name}-pantalla.png`) });
      await page.screenshot({ path: path.join(OUT, `${vp.name}-${name}-completa.png`), fullPage: true });
    } catch (error) {
      console.warn(`${vp.name} ${route}: ${error.message}`);
    }
    report.push({ viewport: vp.name, page: name, route, status, ms: Date.now() - started });
    await page.close();
  }
  await context.close();
}
await browser.close();
writeFileSync(path.join(OUT, 'indice.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
