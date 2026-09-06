import { syncCoverMirror, COVER_MANIFEST_KEY, coverCandidates } from './cover-mirror.js';
import { googleReadyImage } from '../functions/_shared/image-source-policy.js';
import { dedupeByGtinAndCondition, isEligibleForFeed, filterItemsWithReadyPrimaryCover } from '../functions/feed.xml.js';
import { applyBookEnrichment } from '../functions/_shared/book-enrichment-registry.js';

// Temporary authenticated acceptance runner. Writes exclusively to preview.
// Production binding is used only for the read-only quality-gate preflight.
export default {
  async fetch(request, env) {
    if (env.APP_ENV !== 'preview' || !env.PREVIEW_SEED_TOKEN || request.method !== 'POST' ||
        request.headers.get('authorization') !== `Bearer ${env.PREVIEW_SEED_TOKEN}`) {
      return new Response('Forbidden', {status: 403});
    }
    const response = await fetch('https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json');
    if (!response.ok) return new Response('Catalog unavailable', {status: 502});
    const catalog = await response.json();
    const beforeObject = await env.COVER_R2.get(COVER_MANIFEST_KEY);
    const before = beforeObject ? JSON.parse(await beforeObject.text()) : {entries: {}};
    const result = await syncCoverMirror({COVER_R2: env.COVER_R2}, catalog, {limit: 100, concurrency: 3});
    const manifest = JSON.parse(await (await env.COVER_R2.get(COVER_MANIFEST_KEY)).text());
    const entries = result.results.map(row => {
      const entry = manifest.entries[row.key];
      const current = entry?.current;
      const previous = before.entries[row.key]?.current;
      return {key: row.key, id: entry.product_id, position: entry.position, status: row.status,
        previous: previous ? {width: previous.width, height: previous.height, sha256: previous.sha256} : null,
        current, probes: entry.source_probes || [], error: entry.last_error || null,
        google_ready: googleReadyImage(current)};
    });
    const productionObject = await env.PRODUCTION_COVERS_READONLY.get(COVER_MANIFEST_KEY);
    if (!productionObject) throw new Error('Production manifest unavailable for read-only preflight');
    const production = JSON.parse(await productionObject.text());
    const eligible = catalog.items.map(applyBookEnrichment).filter(isEligibleForFeed);
    const currentFeed = dedupeByGtinAndCondition(filterItemsWithReadyPrimaryCover(eligible, production));
    const strictFeed = dedupeByGtinAndCondition(filterItemsWithReadyPrimaryCover(eligible, production, true));
    const qualityReport = JSON.parse(await (await env.COVER_R2.get('covers/v1/quality-report.json')).text());
    return Response.json({bucket: 'amadolibros-images-preview', catalog_updated_at: catalog.updated_at,
      catalog_products: catalog.items.length, catalog_images: catalog.items.flatMap(item => coverCandidates(item)).length,
      selection: 'automatic selectCoverBatch; no product list', result, entries,
      preflight: {production_read_only: true, commercially_eligible: eligible.length,
        current_feed: currentFeed.length, strict_500_feed: strictFeed.length,
        would_exclude: currentFeed.length - strictFeed.length},
      quality: {known_images: qualityReport.known_images, discovery_pending: qualityReport.discovery_pending,
        needs_better_source: qualityReport.needs_better_source.length, unavailable: qualityReport.unavailable.length}},
      {status: result.status === 'completed' ? 200 : 500});
  },
};
