import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API_ROOT = 'https://merchantapi.googleapis.com';
const DEFAULT_ACCOUNT_ID = '5330457716';
const DEFAULT_FEED_URL = 'https://www.amadolibros.com/feed.xml';
const DAY_MS = 24 * 60 * 60 * 1000;

function asText(value) {
  return String(value ?? '').trim();
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function upper(value) {
  return asText(value).toUpperCase();
}

function isDynamicRemarketing(value) {
  const normalized = upper(value);
  return normalized.includes('DYNAMIC') || normalized.includes('REMARKETING') || normalized === 'DISPLAY_ADS';
}

function isUy(value) {
  return upper(value) === 'UY';
}

function safeFetchUri(value) {
  const raw = asText(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[configured]';
  }
}

export function countFeedItems(xml) {
  return [...String(xml || '').matchAll(/<item(?:\s|>)/gi)].length;
}

export function summarizeDataSource(source = {}) {
  const typeKeys = [
    'primaryProductDataSource',
    'supplementalProductDataSource',
    'localInventoryDataSource',
    'regionalInventoryDataSource',
    'promotionDataSource',
    'productReviewDataSource',
    'merchantReviewDataSource',
  ];
  const type = typeKeys.find(key => source[key] != null) || 'unknown';
  const fileInput = source.fileInput || {};
  const fetchSettings = fileInput.fetchSettings || source.fetchSettings || {};
  const timeOfDay = fetchSettings.timeOfDay || {};

  return {
    name: asText(source.name) || null,
    dataSourceId: asText(source.dataSourceId) || null,
    displayName: asText(source.displayName) || '(sin nombre)',
    input: asText(source.input) || null,
    type,
    fileInputType: asText(fileInput.fileInputType || fileInput.inputType) || null,
    fetchUri: safeFetchUri(fetchSettings.fetchUri || fileInput.fetchUri),
    frequency: asText(fetchSettings.frequency) || null,
    dayOfWeek: asText(fetchSettings.dayOfWeek) || null,
    dayOfMonth: fetchSettings.dayOfMonth ?? null,
    timeOfDay: Object.keys(timeOfDay).length
      ? {
          hours: timeOfDay.hours ?? null,
          minutes: timeOfDay.minutes ?? null,
          seconds: timeOfDay.seconds ?? null,
        }
      : null,
  };
}

export function summarizeAccountIssue(issue = {}) {
  const impacted = Array.isArray(issue.impactedDestinations)
    ? issue.impactedDestinations
    : Array.isArray(issue.impacts)
      ? issue.impacts
      : [];
  return {
    name: asText(issue.name) || null,
    title: asText(issue.title) || asText(issue.description) || '(sin título)',
    severity: asText(issue.severity) || null,
    detail: asText(issue.detail) || null,
    documentationUri: asText(issue.documentationUri || issue.documentation) || null,
    impactedDestinations: impacted.map(row => ({
      reportingContext: asText(row.reportingContext) || null,
      impacts: Array.isArray(row.impacts)
        ? row.impacts.map(impact => ({
            regionCode: asText(impact.regionCode) || null,
            severity: asText(impact.severity) || null,
          }))
        : [],
    })),
  };
}

export function aggregateDynamicRemarketingUy(rows = []) {
  const matching = rows.filter(row => isUy(row?.country) && isDynamicRemarketing(row?.reportingContext));
  return matching.reduce((summary, row) => {
    const stats = row.stats || {};
    summary.rows += 1;
    summary.contexts.push(asText(row.reportingContext));
    summary.active += asNumber(stats.activeCount);
    summary.pending += asNumber(stats.pendingCount);
    summary.disapproved += asNumber(stats.disapprovedCount);
    summary.expiring += asNumber(stats.expiringCount);
    for (const issue of Array.isArray(row.itemLevelIssues) ? row.itemLevelIssues : []) {
      const key = asText(issue.code) || '(sin código)';
      const current = summary.issueCounts.get(key) || {
        code: key,
        severity: asText(issue.severity) || null,
        resolution: asText(issue.resolution) || null,
        attribute: asText(issue.attribute) || null,
        description: asText(issue.description) || null,
        detail: asText(issue.detail) || null,
        documentationUri: asText(issue.documentationUri) || null,
        productCount: 0,
      };
      current.productCount += asNumber(issue.productCount);
      summary.issueCounts.set(key, current);
    }
    return summary;
  }, {
    rows: 0,
    contexts: [],
    active: 0,
    pending: 0,
    disapproved: 0,
    expiring: 0,
    issueCounts: new Map(),
  });
}

function finalizeAggregate(summary) {
  return {
    rows: summary.rows,
    contexts: [...new Set(summary.contexts.filter(Boolean))],
    active: summary.active,
    pending: summary.pending,
    disapproved: summary.disapproved,
    expiring: summary.expiring,
    topIssues: [...summary.issueCounts.values()]
      .sort((a, b) => b.productCount - a.productCount || a.code.localeCompare(b.code))
      .slice(0, 30),
  };
}

function productDestinationState(product, country = 'UY') {
  const rows = Array.isArray(product?.productStatus?.destinationStatuses)
    ? product.productStatus.destinationStatuses.filter(row => isDynamicRemarketing(row.reportingContext))
    : [];
  const approved = rows.some(row => (row.approvedCountries || []).some(isUy));
  const pending = rows.some(row => (row.pendingCountries || []).some(isUy));
  const disapproved = rows.some(row => (row.disapprovedCountries || []).some(isUy));
  if (approved) return 'active';
  if (pending) return 'pending';
  if (disapproved) return 'disapproved';
  return rows.length ? 'other_country' : 'missing_context';
}

export function summarizeProducts(products = [], now = new Date()) {
  const nowMs = now.getTime();
  const issueCounts = new Map();
  const bySource = new Map();
  const destination = {
    active: 0,
    pending: 0,
    disapproved: 0,
    other_country: 0,
    missing_context: 0,
  };
  let archived = 0;
  let expiringWithin3Days = 0;
  let expiringWithin7Days = 0;
  let alreadyExpired = 0;
  let oldestUpdate = null;
  let newestUpdate = null;

  for (const product of products) {
    const source = asText(product.dataSource) || '(sin fuente)';
    bySource.set(source, (bySource.get(source) || 0) + 1);
    if (product.archived === true) archived += 1;

    const state = productDestinationState(product);
    destination[state] += 1;

    const status = product.productStatus || {};
    const expirationMs = Date.parse(status.googleExpirationDate || '');
    if (Number.isFinite(expirationMs)) {
      const distance = expirationMs - nowMs;
      if (distance < 0) alreadyExpired += 1;
      else {
        if (distance <= 3 * DAY_MS) expiringWithin3Days += 1;
        if (distance <= 7 * DAY_MS) expiringWithin7Days += 1;
      }
    }

    const updateMs = Date.parse(status.lastUpdateDate || '');
    if (Number.isFinite(updateMs)) {
      if (oldestUpdate == null || updateMs < oldestUpdate) oldestUpdate = updateMs;
      if (newestUpdate == null || updateMs > newestUpdate) newestUpdate = updateMs;
    }

    for (const issue of Array.isArray(status.itemLevelIssues) ? status.itemLevelIssues : []) {
      const countries = Array.isArray(issue.applicableCountries) ? issue.applicableCountries : [];
      if (!isDynamicRemarketing(issue.reportingContext)) continue;
      if (countries.length && !countries.some(isUy)) continue;
      const key = asText(issue.code) || '(sin código)';
      const current = issueCounts.get(key) || {
        code: key,
        severity: asText(issue.severity) || null,
        resolution: asText(issue.resolution) || null,
        attribute: asText(issue.attribute) || null,
        description: asText(issue.description) || null,
        detail: asText(issue.detail) || null,
        documentation: asText(issue.documentation) || null,
        products: 0,
      };
      current.products += 1;
      issueCounts.set(key, current);
    }
  }

  return {
    processed: products.length,
    archived,
    dynamicRemarketingUy: destination,
    expiringWithin3Days,
    expiringWithin7Days,
    alreadyExpired,
    oldestUpdateDate: oldestUpdate == null ? null : new Date(oldestUpdate).toISOString(),
    newestUpdateDate: newestUpdate == null ? null : new Date(newestUpdate).toISOString(),
    byDataSource: [...bySource.entries()]
      .map(([dataSource, count]) => ({ dataSource, count }))
      .sort((a, b) => b.count - a.count || a.dataSource.localeCompare(b.dataSource)),
    topIssues: [...issueCounts.values()]
      .sort((a, b) => b.products - a.products || a.code.localeCompare(b.code))
      .slice(0, 30),
  };
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvRowValue(row, key) {
  const value = row[key];
  if (Array.isArray(value)) return value.join(';');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value ?? '';
}

export function rowsToCsv(columns, rows) {
  const lines = [columns.map(([header]) => csvCell(header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(([, key]) => csvCell(csvRowValue(row, key))).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export const OFFER_CSV_COLUMNS = [
  ['offer_id', 'offerId'],
  ['product_name', 'productName'],
  ['channel', 'channel'],
  ['feed_label', 'feedLabel'],
  ['content_language', 'contentLanguage'],
  ['data_source', 'dataSource'],
  ['data_source_display_name', 'dataSourceDisplayName'],
  ['source_input', 'sourceInput'],
  ['source_type', 'sourceType'],
  ['has_price', 'hasPrice'],
  ['has_image', 'hasImage'],
  ['image_blocking_issue_codes', 'imageBlockingIssueCodes'],
  ['reporting_states', 'reportingStatesText'],
  ['present_in_public_feed', 'presentInPublicFeed'],
  ['evidence', 'evidence'],
];

function decodeXmlEntities(value) {
  return String(value ?? '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function firstTagValue(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  if (!match) return null;
  return decodeXmlEntities(match[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim());
}

export function parseFeedOffers(xml) {
  const text = String(xml || '');
  const items = text.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map(block => {
    const offerId = firstTagValue(block, 'g:id');
    const price = firstTagValue(block, 'g:price');
    const imageLink = firstTagValue(block, 'g:image_link');
    return {
      offerId: offerId || null,
      hasPrice: Boolean(price),
      hasImage: Boolean(imageLink),
    };
  });
}

function hasUsablePrice(price) {
  if (!price || typeof price !== 'object') return false;
  const amount = price.amountMicros ?? price.value ?? price.amount ?? price.priceMicros;
  if (amount == null || asText(amount) === '') return false;
  const numeric = Number(amount);
  return Number.isFinite(numeric) && numeric > 0;
}

function productHasPrice(product = {}) {
  const attrs = product.attributes || {};
  return hasUsablePrice(attrs.price) || hasUsablePrice(product.price);
}

function productImageLink(product = {}) {
  const attrs = product.attributes || {};
  return asText(attrs.imageLink || product.imageLink) || null;
}

const IMAGE_ISSUE_PATTERN = /image/i;

function imageBlockingIssues(product = {}) {
  const issues = Array.isArray(product?.productStatus?.itemLevelIssues) ? product.productStatus.itemLevelIssues : [];
  return issues.filter(issue => IMAGE_ISSUE_PATTERN.test(asText(issue.code)) || IMAGE_ISSUE_PATTERN.test(asText(issue.attribute)));
}

export function summarizeReportingStates(product = {}) {
  const rows = Array.isArray(product?.productStatus?.destinationStatuses) ? product.productStatus.destinationStatuses : [];
  return rows.map(row => ({
    reportingContext: asText(row.reportingContext) || null,
    approvedCountries: Array.isArray(row.approvedCountries) ? row.approvedCountries.map(asText).filter(Boolean) : [],
    pendingCountries: Array.isArray(row.pendingCountries) ? row.pendingCountries.map(asText).filter(Boolean) : [],
    disapprovedCountries: Array.isArray(row.disapprovedCountries) ? row.disapprovedCountries.map(asText).filter(Boolean) : [],
  }));
}

function reportingStatesText(states) {
  return states.map(state => {
    const parts = [];
    if (state.approvedCountries.length) parts.push(`aprobado:${state.approvedCountries.join(',')}`);
    if (state.pendingCountries.length) parts.push(`pendiente:${state.pendingCountries.join(',')}`);
    if (state.disapprovedCountries.length) parts.push(`rechazado:${state.disapprovedCountries.join(',')}`);
    return `${state.reportingContext || '(sin contexto)'}[${parts.join('|') || 'sin datos'}]`;
  }).join('; ');
}

function indexDataSourcesByName(dataSources = []) {
  const map = new Map();
  for (const source of dataSources) {
    if (source?.name) map.set(source.name, source);
  }
  return map;
}

export function buildOfferRow(product = {}, dataSourcesByName = new Map()) {
  const offerId = asText(product.offerId) || null;
  const dataSourceName = asText(product.dataSource) || null;
  const source = dataSourceName ? dataSourcesByName.get(dataSourceName) : null;
  const hasPrice = productHasPrice(product);
  const imageLink = productImageLink(product);
  const blockingIssues = imageBlockingIssues(product);
  const reportingStates = summarizeReportingStates(product);

  const evidence = [
    offerId ? `offer_id=${offerId}` : 'offer_id ausente en el producto',
    dataSourceName ? `dataSource=${dataSourceName}` : 'dataSource ausente',
    source ? `input=${source.input || 'desconocido'} tipo=${source.type}` : 'fuente no resuelta contra dataSources.list',
    hasPrice ? 'precio presente en attributes.price' : 'precio ausente o no numérico en attributes.price',
    imageLink ? 'imageLink presente' : 'imageLink ausente',
    blockingIssues.length ? `issues de imagen: ${blockingIssues.map(issue => asText(issue.code)).join(',')}` : 'sin issues de imagen reportados',
  ].join('; ');

  return {
    offerId,
    productName: asText(product.name) || null,
    channel: asText(product.channel) || null,
    feedLabel: asText(product.feedLabel) || null,
    contentLanguage: asText(product.contentLanguage) || null,
    dataSource: dataSourceName,
    dataSourceDisplayName: source?.displayName || null,
    sourceInput: source?.input || null,
    sourceType: source?.type || null,
    hasPrice,
    hasImage: Boolean(imageLink),
    imageBlockingIssueCodes: blockingIssues.map(issue => asText(issue.code)).filter(Boolean),
    reportingStates,
    reportingStatesText: reportingStatesText(reportingStates),
    presentInPublicFeed: false,
    evidence,
  };
}

export function reconcileOffers(products = [], dataSources = [], feedOffers = []) {
  const dataSourcesByName = indexDataSourcesByName(dataSources);
  const rows = products.map(product => buildOfferRow(product, dataSourcesByName));

  const feedOfferIds = new Set(feedOffers.map(offer => offer.offerId).filter(Boolean));
  for (const row of rows) {
    row.presentInPublicFeed = row.offerId ? feedOfferIds.has(row.offerId) : false;
  }

  const byOffer = new Map();
  for (const row of rows) {
    if (!row.offerId) continue;
    const bucket = byOffer.get(row.offerId) || [];
    bucket.push(row);
    byOffer.set(row.offerId, bucket);
  }

  const overlaps = [];
  for (const [offerId, entries] of byOffer.entries()) {
    const inputs = new Set(entries.map(entry => upper(entry.sourceInput || '')).filter(Boolean));
    if (entries.length > 1 && inputs.has('AUTOFEED') && inputs.has('FILE')) {
      overlaps.push({ offerId, entries });
    }
  }
  overlaps.sort((a, b) => a.offerId.localeCompare(b.offerId));

  const missingPrice = rows.filter(row => row.offerId && !row.hasPrice);
  const missingImage = rows.filter(row => row.offerId && (!row.hasImage || row.imageBlockingIssueCodes.length > 0));
  const missingOfferId = rows.filter(row => !row.offerId).length;

  const sourceCounts = new Map();
  for (const row of rows) {
    const key = row.sourceInput || '(desconocida)';
    sourceCounts.set(key, (sourceCounts.get(key) || 0) + 1);
  }

  const uniqueOfferIds = new Set(rows.filter(row => row.offerId).map(row => row.offerId));
  const feedOnlyOfferIds = [...feedOfferIds].filter(id => !uniqueOfferIds.has(id)).length;

  return {
    rows,
    uniqueOffers: uniqueOfferIds.size,
    offersBySource: [...sourceCounts.entries()]
      .map(([input, count]) => ({ input, count }))
      .sort((a, b) => b.count - a.count || a.input.localeCompare(b.input)),
    overlaps,
    missingPrice,
    missingImage,
    missingOfferId,
    feedOfferCount: feedOffers.length,
    feedOnlyOfferIds,
  };
}

export function buildReconciliationDiagnosis({
  rows,
  overlaps,
  missingPrice,
  missingImage,
  offersBySource,
  feedOfferCount,
  feedOnlyOfferIds,
  missingOfferId,
}) {
  const facts = [];
  const hypotheses = [];
  const limitations = [];

  facts.push(`Se procesaron ${rows.length} productos de Merchant con datos de offer_id, precio e imagen tal como los devolvió la API.`);
  facts.push(`Se identificaron ${overlaps.length} offer_id presentes simultáneamente en fuentes AUTOFEED y FILE, con evidencia por dataSource.`);
  facts.push(`${missingPrice.length} productos no tienen un precio utilizable en attributes.price.`);
  facts.push(`${missingImage.length} productos no tienen imageLink o registran issues de imagen bloqueantes.`);
  if (feedOfferCount != null) facts.push(`El feed público expuso ${feedOfferCount} ofertas con g:id legible en esta lectura.`);
  if (missingOfferId) facts.push(`${missingOfferId} productos de la API no exponen offerId legible y quedaron fuera de la reconciliación por offer_id.`);

  if (!overlaps.length) {
    hypotheses.push({
      confidence: 'medium',
      text: 'No se confirmó solapamiento AUTOFEED/FILE por offer_id en esta lectura; esto no descarta duplicación bajo combinaciones de channel/feedLabel/contentLanguage no comparadas, ni duplicación oculta por la vista fusionada de products.list.',
    });
  }
  const inputsSeen = new Set(offersBySource.map(row => upper(row.input)));
  if (!inputsSeen.has('AUTOFEED') || !inputsSeen.has('FILE')) {
    hypotheses.push({
      confidence: 'medium',
      text: 'No se observaron productos resueltos simultáneamente a fuentes AUTOFEED y FILE en esta lectura; puede deberse a que una de esas fuentes no está activa o a que Merchant resolvió todos los productos hacia una única fuente ganadora.',
    });
  }
  if (feedOnlyOfferIds) {
    hypotheses.push({
      confidence: 'low',
      text: `${feedOnlyOfferIds} offer_id aparecen en el feed público pero no se encontraron en los productos devueltos por la API en esta lectura; puede deberse a demora de procesamiento, límites de paginación o diferencias entre el feed público y la fuente que Merchant realmente consume.`,
    });
  }

  limitations.push('products.list devuelve la vista fusionada por offer_id que resultó ganadora en Merchant; no expone todas las fuentes que compitieron por un mismo offer_id, sólo la fuente resultante para cada combinación de channel/feedLabel/contentLanguage.');
  limitations.push('Merchant API v1 no ofrece un endpoint GET de sólo lectura para listar productInputs individuales por fuente; esta reconciliación se basa exclusivamente en products.list y dataSources.list.');
  limitations.push('La presencia de precio e imagen se evalúa sólo sobre los campos que la API devolvió en esta lectura (attributes.price, attributes.imageLink); no se asume ni se completa ningún valor no reportado por Merchant.');

  return { facts, hypotheses, limitations };
}

export function reconciliationMarkdown(report) {
  const lines = [
    '# Merchant Center — reconciliación de ofertas por offer_id',
    '',
    `- Fecha de auditoría: ${report.generatedAt}`,
    `- Cuenta: ${report.accountId}`,
    `- Fuentes observadas: ${report.sourcesObserved.length ? report.sourcesObserved.join(', ') : '(ninguna)'}`,
    `- Ofertas únicas (por offer_id, vista API): ${report.uniqueOffers}`,
    `- Ofertas del feed público con g:id legible: ${report.feedOfferCount}`,
    '',
    '## Ofertas por fuente',
    '',
    '| Fuente (input) | Productos |',
    '| --- | ---: |',
  ];
  if (!report.offersBySource.length) lines.push('| — | 0 |');
  for (const row of report.offersBySource) lines.push(`| ${markdownEscape(row.input)} | ${row.count} |`);

  lines.push('', '## Solapamiento AUTOFEED / FILE confirmado', '');
  lines.push(`- Ofertas con el mismo offer_id presentes simultáneamente en AUTOFEED y FILE: ${report.overlapConfirmedCount}`);
  if (report.overlapConfirmedCount) {
    lines.push('', '| offer_id | fuentes involucradas |', '| --- | --- |');
    for (const overlap of report.overlaps.slice(0, 50)) {
      lines.push(`| ${markdownEscape(overlap.offerId)} | ${overlap.entries.map(entry => markdownEscape(entry.sourceInput || '—')).join(', ')} |`);
    }
  }

  lines.push('', '## Precio ausente', '', `- Productos sin precio utilizable: ${report.missingPriceCount}`);
  lines.push('', '## Imagen ausente o bloqueante', '', `- Productos sin imagen o con issues bloqueantes de imagen: ${report.missingImageCount}`);

  lines.push('', '## Comparación contra snapshots históricos', '');
  lines.push(`- Referencia histórica (no asumida como resultado): ${report.historicalSnapshots.missingPrice} sin precio, ${report.historicalSnapshots.missingImage} con imagen bloqueante, ${report.historicalSnapshots.overlapSuspected}.`);
  lines.push(`- Observado en esta lectura: ${report.missingPriceCount} sin precio, ${report.missingImageCount} con imagen ausente/bloqueante, ${report.overlapConfirmedCount} solapamientos AUTOFEED/FILE confirmados.`);
  lines.push('- Los valores históricos son sólo referencia para comparar; esta lectura no los reutiliza ni los fuerza como resultado.');

  lines.push('', '## Hechos comprobados', '');
  for (const fact of report.diagnosis.facts) lines.push(`- ${fact}`);
  lines.push('', '## Hipótesis y limitaciones', '');
  for (const hypothesis of report.diagnosis.hypotheses) lines.push(`- (${hypothesis.confidence}) ${hypothesis.text}`);
  for (const limitation of report.diagnosis.limitations) lines.push(`- Limitación: ${limitation}`);

  lines.push('', '> Esta reconciliación es de solo lectura. No modifica, corrige, crea ni elimina productos ni fuentes en Merchant Center.');
  return `${lines.join('\n')}\n`;
}

export function buildDiagnosis({ alert, feedCount, dataSources, accountIssues, aggregate, products }) {
  const facts = [];
  const hypotheses = [];
  const active = aggregate?.active || products?.dynamicRemarketingUy?.active || 0;
  const primarySources = dataSources.filter(row => row.type === 'primaryProductDataSource');

  facts.push(`El correo informó una caída de ${alert.previousActive} a ${alert.currentActive} artículos activos para Dynamic remarketing en UY.`);
  if (feedCount != null) facts.push(`El feed público contiene ${feedCount} ofertas en esta lectura.`);
  if (products) facts.push(`Merchant devolvió ${products.processed} productos procesados.`);
  if (active) facts.push(`La API informó ${active} productos activos para Dynamic remarketing en UY.`);
  if (aggregate?.pending) facts.push(`${aggregate.pending} productos están pendientes para ese destino.`);
  if (aggregate?.disapproved) facts.push(`${aggregate.disapproved} productos están rechazados para ese destino.`);
  if (aggregate?.expiring || products?.expiringWithin3Days) {
    facts.push(`${aggregate?.expiring || products?.expiringWithin3Days} productos aparecen próximos a vencer.`);
  }
  if (accountIssues.length) facts.push(`Hay ${accountIssues.length} problemas de cuenta devueltos por la API.`);

  if (feedCount != null && active && feedCount > active) {
    hypotheses.push({
      confidence: 'high',
      text: `Hay ${feedCount - active} ofertas en el feed que no están activas para Dynamic remarketing UY; la causa debe localizarse en procesamiento, vencimiento, reglas o rechazos de Merchant.`,
    });
  }
  if (feedCount != null && alert.previousActive > feedCount) {
    hypotheses.push({
      confidence: 'medium',
      text: `La cifra anterior de activos superaba al feed actual por ${alert.previousActive - feedCount}; esto es compatible con productos antiguos o una fuente adicional que luego vencieron o dejaron de servir.`,
    });
  }
  if (primarySources.length > 1) {
    hypotheses.push({
      confidence: 'high',
      text: `Merchant tiene ${primarySources.length} fuentes primarias; hay que revisar si una fuente vieja o automática está duplicando o caducando productos.`,
    });
  }
  if (products?.expiringWithin3Days > 0) {
    hypotheses.push({
      confidence: 'high',
      text: `${products.expiringWithin3Days} productos procesados vencen dentro de 3 días y pueden explicar parte de la alerta.`,
    });
  }

  return { facts, hypotheses };
}

export async function requestJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const error = new Error(data?.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.apiStatus = data?.error?.status || null;
    error.details = Array.isArray(data?.error?.details)
      ? data.error.details.map(row => ({
          type: row?.['@type'] || null,
          reason: row?.reason || row?.metadata?.service || null,
        }))
      : [];
    throw error;
  }
  return data || {};
}

export async function listAll({ endpoint, arrayField, pageSize, accessToken }) {
  const rows = [];
  let pageToken = '';
  for (let page = 0; page < 30; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await requestJson(url, accessToken);
    if (Array.isArray(data[arrayField])) rows.push(...data[arrayField]);
    pageToken = asText(data.nextPageToken);
    if (!pageToken) return rows;
  }
  throw new Error(`Paginación excedió 30 páginas para ${arrayField}`);
}

export function endpointError(error) {
  return {
    message: asText(error?.message) || 'Error desconocido',
    httpStatus: Number(error?.status) || null,
    apiStatus: asText(error?.apiStatus) || null,
    details: Array.isArray(error?.details) ? error.details : [],
  };
}

async function runEndpoint(name, fn) {
  try {
    return { name, ok: true, data: await fn(), error: null };
  } catch (error) {
    return { name, ok: false, data: null, error: endpointError(error) };
  }
}

function markdownEscape(value) {
  return asText(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function reportMarkdown(report) {
  const lines = [
    '# Merchant Center — auditoría de solo lectura',
    '',
    `- Cuenta: ${report.accountId}`,
    `- Generado: ${report.generatedAt}`,
    `- Feed público: ${report.publicFeed.ok ? `${report.publicFeed.items} ofertas` : `error: ${report.publicFeed.error}`}`,
    '',
    '## Alerta recibida',
    '',
    `Dynamic remarketing UY: ${report.alert.previousActive} → ${report.alert.currentActive} (${report.alert.dropPercent}% de descenso; ${report.alert.dropCount} artículos).`,
    '',
  ];

  if (report.dynamicRemarketingUy) {
    const row = report.dynamicRemarketingUy;
    lines.push(
      '## Estado API — Dynamic remarketing UY',
      '',
      '| Activos | Pendientes | Rechazados | Próximos a vencer |',
      '| ---: | ---: | ---: | ---: |',
      `| ${row.active} | ${row.pending} | ${row.disapproved} | ${row.expiring} |`,
      '',
    );
  }

  if (report.products) {
    const product = report.products;
    lines.push(
      '## Productos procesados',
      '',
      `- Total procesado: ${product.processed}`,
      `- Vencen en 3 días: ${product.expiringWithin3Days}`,
      `- Vencen en 7 días: ${product.expiringWithin7Days}`,
      `- Archivados: ${product.archived}`,
      '',
    );
  }

  lines.push('## Fuentes de datos', '', '| Fuente | Tipo | Entrada | Frecuencia | URI segura |', '| --- | --- | --- | --- | --- |');
  if (!report.dataSources.length) lines.push('| — | — | — | — | — |');
  for (const source of report.dataSources) {
    lines.push(`| ${markdownEscape(source.displayName)} | ${source.type} | ${source.input || '—'} | ${source.frequency || '—'} | ${markdownEscape(source.fetchUri || '—')} |`);
  }
  lines.push('', '## Diagnóstico', '');
  for (const fact of report.diagnosis.facts) lines.push(`- Hecho: ${fact}`);
  for (const hypothesis of report.diagnosis.hypotheses) lines.push(`- Hipótesis ${hypothesis.confidence}: ${hypothesis.text}`);

  lines.push('', '## Problemas principales', '', '| Código | Severidad | Productos | Descripción |', '| --- | --- | ---: | --- |');
  const issues = report.dynamicRemarketingUy?.topIssues?.length
    ? report.dynamicRemarketingUy.topIssues
    : report.products?.topIssues || [];
  if (!issues.length) lines.push('| — | — | 0 | Sin problemas devueltos para este destino |');
  for (const issue of issues.slice(0, 20)) {
    lines.push(`| ${markdownEscape(issue.code)} | ${issue.severity || '—'} | ${issue.productCount ?? issue.products ?? 0} | ${markdownEscape(issue.description || issue.detail || '—')} |`);
  }

  lines.push('', '## Endpoints', '');
  for (const endpoint of report.endpoints) {
    lines.push(`- ${endpoint.name}: ${endpoint.ok ? 'OK' : `ERROR ${endpoint.error?.httpStatus || ''} ${endpoint.error?.apiStatus || ''} — ${endpoint.error?.message || ''}`}`);
  }
  lines.push('', '> Esta auditoría no modifica, recupera, crea ni elimina productos o fuentes. Todas las llamadas a Merchant API son GET.');
  return `${lines.join('\n')}\n`;
}

export async function main() {
  const accessToken = asText(process.env.MERCHANT_ACCESS_TOKEN);
  const accountId = asText(process.env.MERCHANT_ACCOUNT_ID) || DEFAULT_ACCOUNT_ID;
  const outputDir = asText(process.env.MERCHANT_OUTPUT_DIR) || 'artifacts/merchant';
  const feedUrl = asText(process.env.MERCHANT_PUBLIC_FEED_URL) || DEFAULT_FEED_URL;
  if (!accessToken) throw new Error('Falta MERCHANT_ACCESS_TOKEN.');
  if (!/^\d+$/.test(accountId)) throw new Error('MERCHANT_ACCOUNT_ID inválido.');

  const parent = `accounts/${accountId}`;
  const endpoints = [];
  endpoints.push(await runEndpoint('accountIssues', () => listAll({
    endpoint: `${API_ROOT}/accounts/v1/${parent}/issues?languageCode=es-419&timeZone=America%2FMontevideo`,
    arrayField: 'accountIssues',
    pageSize: 100,
    accessToken,
  })));
  endpoints.push(await runEndpoint('dataSources', () => listAll({
    endpoint: `${API_ROOT}/datasources/v1/${parent}/dataSources`,
    arrayField: 'dataSources',
    pageSize: 1000,
    accessToken,
  })));
  endpoints.push(await runEndpoint('aggregateProductStatuses', () => listAll({
    endpoint: `${API_ROOT}/issueresolution/v1/${parent}/aggregateProductStatuses`,
    arrayField: 'aggregateProductStatuses',
    pageSize: 250,
    accessToken,
  })));
  endpoints.push(await runEndpoint('products', () => listAll({
    endpoint: `${API_ROOT}/products/v1/${parent}/products`,
    arrayField: 'products',
    pageSize: 1000,
    accessToken,
  })));

  const byName = Object.fromEntries(endpoints.map(row => [row.name, row]));
  let feedXml = '';
  const publicFeed = await (async () => {
    try {
      const response = await fetch(feedUrl, { signal: AbortSignal.timeout(60_000) });
      const xml = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      feedXml = xml;
      return { ok: true, url: feedUrl, items: countFeedItems(xml), bytes: Buffer.byteLength(xml) };
    } catch (error) {
      return { ok: false, url: feedUrl, items: null, bytes: null, error: asText(error?.message) };
    }
  })();

  const dataSources = (byName.dataSources.data || []).map(summarizeDataSource);
  const accountIssues = (byName.accountIssues.data || []).map(summarizeAccountIssue);
  const aggregate = finalizeAggregate(aggregateDynamicRemarketingUy(byName.aggregateProductStatuses.data || []));
  const products = byName.products.ok ? summarizeProducts(byName.products.data || [], new Date()) : null;
  const alert = {
    observedAt: '2026-08-17T00:20:00-03:00',
    previousActive: 3745,
    currentActive: 2981,
    dropCount: 764,
    dropPercent: 20,
    reportingContext: 'Dynamic remarketing',
    country: 'UY',
  };
  const dynamicRemarketingUy = aggregate.rows ? aggregate : products
    ? {
        rows: 0,
        contexts: [],
        active: products.dynamicRemarketingUy.active,
        pending: products.dynamicRemarketingUy.pending,
        disapproved: products.dynamicRemarketingUy.disapproved,
        expiring: products.expiringWithin3Days,
        topIssues: products.topIssues,
      }
    : null;

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    accountId,
    alert,
    publicFeed,
    endpoints: endpoints.map(row => ({ name: row.name, ok: row.ok, error: row.error })),
    dataSources,
    accountIssues,
    aggregateStatuses: byName.aggregateProductStatuses.ok ? byName.aggregateProductStatuses.data : null,
    dynamicRemarketingUy,
    products,
    diagnosis: buildDiagnosis({
      alert,
      feedCount: publicFeed.ok ? publicFeed.items : null,
      dataSources,
      accountIssues,
      aggregate: dynamicRemarketingUy,
      products,
    }),
  };

  const feedOffers = publicFeed.ok ? parseFeedOffers(feedXml) : [];
  const reconciliation = reconcileOffers(byName.products.data || [], dataSources, feedOffers);
  const reconciliationDiagnosis = buildReconciliationDiagnosis(reconciliation);
  const offerReconciliationReport = {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    accountId,
    sourcesObserved: reconciliation.offersBySource.map(row => row.input),
    uniqueOffers: reconciliation.uniqueOffers,
    offersBySource: reconciliation.offersBySource,
    overlapConfirmedCount: reconciliation.overlaps.length,
    overlaps: reconciliation.overlaps,
    missingPriceCount: reconciliation.missingPrice.length,
    missingImageCount: reconciliation.missingImage.length,
    missingOfferId: reconciliation.missingOfferId,
    feedOfferCount: reconciliation.feedOfferCount,
    feedOnlyOfferIds: reconciliation.feedOnlyOfferIds,
    historicalSnapshots: {
      missingPrice: 47,
      missingImage: 18,
      overlapSuspected: 'posible solapamiento AUTOFEED/FILE (referencia histórica, no confirmada previamente)',
    },
    diagnosis: reconciliationDiagnosis,
    rows: reconciliation.rows,
  };
  const overlapEntries = reconciliation.overlaps.flatMap(overlap => overlap.entries);

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, 'merchant-readonly-report.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(outputDir, 'report-summary.md'), reportMarkdown(report)),
    writeFile(path.join(outputDir, 'account-issues.json'), `${JSON.stringify(accountIssues, null, 2)}\n`),
    writeFile(path.join(outputDir, 'data-sources.json'), `${JSON.stringify(dataSources, null, 2)}\n`),
    writeFile(path.join(outputDir, 'offer-reconciliation.json'), `${JSON.stringify(offerReconciliationReport, null, 2)}\n`),
    writeFile(path.join(outputDir, 'offer-reconciliation.csv'), rowsToCsv(OFFER_CSV_COLUMNS, reconciliation.rows)),
    writeFile(path.join(outputDir, 'missing-price.csv'), rowsToCsv(OFFER_CSV_COLUMNS, reconciliation.missingPrice)),
    writeFile(path.join(outputDir, 'missing-image.csv'), rowsToCsv(OFFER_CSV_COLUMNS, reconciliation.missingImage)),
    writeFile(path.join(outputDir, 'source-overlap.csv'), rowsToCsv(OFFER_CSV_COLUMNS, overlapEntries)),
    writeFile(path.join(outputDir, 'offer-reconciliation-summary.md'), reconciliationMarkdown(offerReconciliationReport)),
  ]);

  console.log(JSON.stringify({
    accountId,
    publicFeedItems: publicFeed.items,
    dynamicRemarketingUy,
    processedProducts: products?.processed ?? null,
    reconciliation: {
      uniqueOffers: reconciliation.uniqueOffers,
      overlapConfirmedCount: reconciliation.overlaps.length,
      missingPriceCount: reconciliation.missingPrice.length,
      missingImageCount: reconciliation.missingImage.length,
    },
    endpointFailures: endpoints.filter(row => !row.ok).map(row => row.name),
  }));

  if (!byName.aggregateProductStatuses.ok && !byName.products.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
