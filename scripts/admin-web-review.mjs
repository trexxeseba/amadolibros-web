// Vista autocontenida: las pestañas usan fragmentos HTML/CSS, sin JavaScript.
// Sigue funcionando cuando el visor de archivos no ejecuta scripts.
// Nunca incluye pedidos ni métricas de GA4 reales en el archivo de revisión.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderAdminWeb } from '../functions/_shared/admin-web-view.js';
import { webPeriod, readWebCatalog, readWebSync } from '../functions/_shared/admin-web-data.js';

const missing = source => ({ status: 'unavailable', source, reason: 'Sin conectar en esta vista de revisión' });
export function buildAdminWebReview({ now = new Date(), catalog = missing('Catálogo de la web'), sync = missing('Actualización del catálogo') } = {}) {
const pages = {};
for (const days of [7, 30]) {
  for (const view of ['resumen','visitas','compra','pedidos','productos','estado']) {
    const html = renderAdminWeb({ view, period: webPeriod(days, now), environment: 'preview',
      checkedAt: now.toISOString(), analytics: missing('Google Analytics 4 · web'),
      orders: missing('Pedidos de la web'), emails: missing('Correos de pedidos'), catalog, sync });
    pages[`${view}:${days}`] = html
      .replace(/<form class="search"[\s\S]*?<\/form>/, '<p class="notice">La búsqueda estará disponible al conectar el panel. Esta vista permite revisar su estructura.</p>')
      .replace(/<nav class="pagination"[\s\S]*?<\/nav>/, '')
      .replace('Versión de revisión. Pedidos de prueba o sin conectar; catálogo público de la web. No modifica la tienda.',
        'Vista previa de la estructura. Las secciones se abren dentro de este archivo; las fuentes pendientes se indican como sin conectar. No modifica la tienda.')
      .replace(/href="\/admin\?([^"]+)"/g, (_match, query) => {
        const params = new URLSearchParams(query.replaceAll('&amp;', '&'));
        const targetView = params.get('view') || 'resumen';
        const targetDays = params.get('days') || '7';
        return `href="#${targetView}-${targetDays}"`;
      });
  }
}
// Resumen/7 al final: visible por defecto; cualquier otro :target lo oculta.
// Si no hay CSS, el contenido completo y los destinos igualmente existen.
const order = [...Object.keys(pages).filter(key => key !== 'resumen:7'), 'resumen:7'];
const screens = order.map(key => {
  const id = key.replace(':', '-');
  const body = pages[key].match(/<body>([\s\S]*)<\/body>/)[1]
    .replace(/<a class="skip"[^>]*>[\s\S]*?<\/a>/, '')
    .replace('id="contenido"', `id="contenido-${id}"`);
  return `<section class="review-screen" id="${id}" tabindex="-1">${body}</section>`;
});
const extraStyle = `<style>
.review-screen{display:none;scroll-margin-top:0}
.review-screen:target{display:block}
.review-screen:last-child{display:block}
.review-screen:target~.review-screen:last-child{display:none}
@media print{.review-screen{display:block!important;break-before:page}.sidebar{display:none}.layout{display:block}}
</style>`;
const head = pages['resumen:7'].split('<body>')[0].replace('</head>', `${extraStyle}</head>`);
return `${head}<body>${screens.join('\n')}</body></html>`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const now = new Date();
  const [catalog, sync] = process.env.ADMIN_WEB_REVIEW_PUBLIC === 'true'
    ? await Promise.all([readWebCatalog(), readWebSync(fetch, now)])
    : [missing('Catálogo de la web'), missing('Actualización del catálogo')];
  const file = resolve(process.env.ADMIN_WEB_REVIEW_OUTPUT || 'artifacts/admin-web-review/AMADO-panel-revision-corregido.html');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buildAdminWebReview({ now, catalog, sync }));
  console.log(JSON.stringify({ file, catalog: catalog.status, sync: sync.status, navigation: 'same-file fragments, no scripts' }));
}
