import { syncCoverMirror, COVER_MANIFEST_KEY } from './cover-mirror.js';
import { VERIFIED_COVER_SOURCES } from '../functions/_shared/verified-cover-sources.js';

// Temporary, authenticated Worker. Its config binds ONLY the existing preview bucket.
export default {
  async fetch(request, env) {
    if (env.APP_ENV !== 'preview' || !env.PREVIEW_SEED_TOKEN || request.method !== 'POST' ||
        request.headers.get('authorization') !== `Bearer ${env.PREVIEW_SEED_TOKEN}`) {
      return new Response('Forbidden', { status: 403 });
    }
    const response = await fetch('https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json');
    if (!response.ok) return new Response('Catalog unavailable', { status: 502 });
    const catalog = await response.json();
    const ids = [...new Set(VERIFIED_COVER_SOURCES.map(row => row.product_id))];
    const items = ids.map(id => {
      const item = catalog.items.find(row => row.id === id);
      if (!item || item.status !== 'active' || !(Number(item.available_quantity) > 0)) throw new Error('Cohort changed: '+id);
      const entries = VERIFIED_COVER_SOURCES.filter(row => row.product_id === id);
      // Only the verified leading positions: four fronts and one back cover.
      const pictures = [...new Set(item.pictures)].slice(0, entries.length);
      if (pictures.some((url, index) => url !== entries[index].source_url) || pictures.length !== entries.length) {
        throw new Error('Source positions changed: '+id);
      }
      return {...item, pictures};
    });
    const result = await syncCoverMirror({ COVER_R2: env.COVER_R2 }, { items }, { limit: 5 });
    const manifest = JSON.parse(await (await env.COVER_R2.get(COVER_MANIFEST_KEY)).text());
    const entries = ids.flatMap(id => VERIFIED_COVER_SOURCES.filter(row=>row.product_id===id).map((source,position) => {
      const current = manifest.entries[`${id}:${position}`]?.current;
      if (!current || current.source_url !== source.replacement_url || current.width < 500 || current.height < 500 || current.transform) {
        throw new Error('Native R2 copy not ready: '+id+':'+position);
      }
      return {id,position,...current};
    }));
    return Response.json({bucket:'amadolibros-images-preview',result,entries}, {status: result.failed ? 500 : 200});
  },
};
