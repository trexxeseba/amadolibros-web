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

// aggregateDynamicRemarketingUy() filtra deliberadamente a un solo destino
// (Dynamic remarketing / DISPLAY_ADS) — así nació esta auditoría, para una
// alerta puntual de ese destino. Eso deja ciego al resto: Shopping ads,
// Free listings o cualquier otro reportingContext que la cuenta use nunca
// se ven. Esta función agrupa TODOS los reportingContext reales que la API
// devuelve para Uruguay, sin descartar ninguno — amplía el diagnóstico sin
// tocar ni reemplazar el agregado específico de Dynamic remarketing que ya
// existía (se mantiene igual, como campo aparte).
export function aggregateProductStatusesByContextUy(rows = []) {
  const byContext = new Map();
  for (const row of rows) {
    if (!isUy(row?.country)) continue;
    const context = asText(row?.reportingContext) || '(sin reportingContext)';
    const current = byContext.get(context) || {
      reportingContext: context,
      rows: 0,
      active: 0,
      pending: 0,
      disapproved: 0,
      expiring: 0,
      issueCounts: new Map(),
    };
    const stats = row.stats || {};
    current.rows += 1;
    current.active += asNumber(stats.activeCount);
    current.pending += asNumber(stats.pendingCount);
    current.disapproved += asNumber(stats.disapprovedCount);
    current.expiring += asNumber(stats.expiringCount);
    for (const issue of Array.isArray(row.itemLevelIssues) ? row.itemLevelIssues : []) {
      const key = asText(issue.code) || '(sin código)';
      const issueCurrent = current.issueCounts.get(key) || {
        code: key,
        severity: asText(issue.severity) || null,
        resolution: asText(issue.resolution) || null,
        attribute: asText(issue.attribute) || null,
        description: asText(issue.description) || null,
        detail: asText(issue.detail) || null,
        documentationUri: asText(issue.documentationUri) || null,
        productCount: 0,
      };
      issueCurrent.productCount += asNumber(issue.productCount);
      current.issueCounts.set(key, issueCurrent);
    }
    byContext.set(context, current);
  }
  return byContext;
}

export function finalizeContextSummary(summary, limit = 30) {
  return {
    reportingContext: summary.reportingContext,
    rows: summary.rows,
    active: summary.active,
    pending: summary.pending,
    disapproved: summary.disapproved,
    expiring: summary.expiring,
    topIssues: [...summary.issueCounts.values()]
      .sort((a, b) => b.productCount - a.productCount || a.code.localeCompare(b.code))
      .slice(0, limit),
  };
}

// Une el conteo real de products.list (por dataSource) con los metadatos de
// datasources.list (displayName/type/input) — ambos endpoints ya se leían
// por separado, esto sólo los cruza para poder mostrar cantidad por fuente.
export function joinDataSourceProductCounts(dataSources = [], byDataSource = []) {
  const countByName = new Map(byDataSource.map(row => [row.dataSource, row.count]));
  return dataSources.map(source => ({
    ...source,
    productCount: source.name ? (countByName.get(source.name) || 0) : 0,
  }));
}

// Resumen de un accountIssue para stdout: sin PII (nunca hubo en accountIssues,
// es información de cuenta/política, no de comprador) y sin duplicar el
// detalle completo — sólo lo que hace falta para priorizar.
export function accountIssueLogSummary(issue = {}) {
  const destinations = [...new Set(
    (Array.isArray(issue.impactedDestinations) ? issue.impactedDestinations : [])
      .map(row => asText(row.reportingContext))
      .filter(Boolean)
  )];
  return {
    title: issue.title || '(sin título)',
    severity: issue.severity || null,
    destinations,
  };
}

// Segunda ampliación (misma auditoría de solo lectura, mismo PR): las
// secciones anteriores ya muestran cuántos productos bloquean cada código de
// issue por reportingContext, pero no CUÁLES productos son. Estas funciones
// recorren la lista de productos ya obtenida por products.list (sin ninguna
// llamada nueva) y arman el detalle producto por producto para los bloqueos
// prioritarios, más el cruce real de offer_id entre AUTOFEED y FILE.

function productOfferId(product) {
  return asText(product?.offerId) || asText(product?.productAttributes?.offerId) || null;
}

function productTitle(product) {
  return asText(product?.productAttributes?.title) || asText(product?.title) || '(sin título)';
}

function productPriceText(product) {
  const price = product?.productAttributes?.price;
  if (!price || price.amountMicros == null) return null;
  const amount = Number(price.amountMicros) / 1_000_000;
  const currency = asText(price.currencyCode);
  return `${Number.isFinite(amount) ? amount.toFixed(2) : price.amountMicros}${currency ? ` ${currency}` : ''}`;
}

function productAvailability(product) {
  return asText(product?.productAttributes?.availability) || null;
}

function productGtin(product) {
  const attrs = product?.productAttributes || {};
  if (asText(attrs.gtin)) return asText(attrs.gtin);
  if (Array.isArray(attrs.gtins) && attrs.gtins.length) return asText(attrs.gtins[0]) || null;
  return null;
}

export function productDestinationStatus(product, context) {
  const rows = Array.isArray(product?.productStatus?.destinationStatuses) ? product.productStatus.destinationStatuses : [];
  const row = rows.find(entry => upper(entry.reportingContext) === upper(context));
  if (!row) return 'missing_context';
  if ((row.approvedCountries || []).some(isUy)) return 'active';
  if ((row.pendingCountries || []).some(isUy)) return 'pending';
  if ((row.disapprovedCountries || []).some(isUy)) return 'disapproved';
  return 'other_country';
}

function productRow(product) {
  return {
    offerId: productOfferId(product),
    title: productTitle(product),
    dataSource: asText(product.dataSource) || null,
    link: safeFetchUri(product?.productAttributes?.link),
    imageLink: safeFetchUri(product?.productAttributes?.imageLink),
    price: productPriceText(product),
    availability: productAvailability(product),
    gtin: productGtin(product),
    shoppingAdsStatus: productDestinationStatus(product, 'SHOPPING_ADS'),
    freeListingsStatus: productDestinationStatus(product, 'FREE_LISTINGS'),
  };
}

// Tercera ampliación (mismo PR): el cruce por offer_id (arriba) no responde
// si dos offer_id distintos son en realidad el mismo libro — para eso hace
// falta identidad real: mismo link (landing page) o mismo GTIN/ISBN. Ambos
// campos ya vienen en productAttributes de products.list, así que esto
// sigue siendo post-procesamiento en memoria, sin ninguna llamada nueva.
export function normalizeLink(url) {
  const raw = asText(url);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return `${parsed.hostname.toLowerCase()}${path}`;
  } catch {
    return raw.toLowerCase();
  }
}

export function buildIdentityIndex(rows = []) {
  const byLink = new Map();
  const byGtin = new Map();
  for (const row of rows) {
    const link = normalizeLink(row.link);
    if (link) {
      if (!byLink.has(link)) byLink.set(link, []);
      byLink.get(link).push(row);
    }
    if (row.gtin) {
      if (!byGtin.has(row.gtin)) byGtin.set(row.gtin, []);
      byGtin.get(row.gtin).push(row);
    }
  }
  return { byLink, byGtin };
}

// Busca, para un producto de una fuente, su probable gemelo en el índice de
// identidad de la otra fuente: primero por link normalizado, si no por GTIN.
export function findTwin(row, identityIndex) {
  const link = normalizeLink(row.link);
  const byLink = link ? identityIndex.byLink.get(link) : null;
  if (byLink?.length) return { offerId: byLink[0].offerId, title: byLink[0].title, matchedBy: 'link' };
  const byGtin = row.gtin ? identityIndex.byGtin.get(row.gtin) : null;
  if (byGtin?.length) return { offerId: byGtin[0].offerId, title: byGtin[0].title, matchedBy: 'gtin' };
  return null;
}

// Reconciliación de catálogo completo entre dos fuentes por identidad real
// (no offer_id): cuántos productos de rowsA tienen un probable gemelo en
// indexB, por qué campo, y una muestra para inspección manual.
export function reconcileIdentity(rowsA = [], indexB, sampleSize = 20) {
  let linkMatches = 0;
  let gtinMatches = 0;
  const sameBook = new Set();
  const sample = [];
  for (const row of rowsA) {
    const twin = findTwin(row, indexB);
    if (!twin) continue;
    sameBook.add(row.offerId);
    if (twin.matchedBy === 'link') linkMatches += 1;
    else gtinMatches += 1;
    if (sample.length < sampleSize) sample.push({ offerIdA: row.offerId, titleA: row.title, ...twin });
  }
  return {
    rowsChecked: rowsA.length,
    withLink: rowsA.filter(row => row.link).length,
    withGtin: rowsA.filter(row => row.gtin).length,
    linkMatches,
    gtinMatches,
    probableSameBook: sameBook.size,
    sample,
  };
}

// Lista, de-duplicada por offer_id, los productos cuyo productStatus trae un
// itemLevelIssue con ese código (y, si se pide, ese atributo y esos
// reportingContext). Puro filtrado en memoria sobre datos ya leídos.
export function listProductsByIssueCode(products = [], { code, attribute = null, contexts = [] } = {}) {
  const wantedContexts = contexts.map(upper);
  const seen = new Map();
  for (const product of products) {
    const issues = Array.isArray(product?.productStatus?.itemLevelIssues) ? product.productStatus.itemLevelIssues : [];
    const matched = issues.some(issue =>
      asText(issue.code) === code &&
      (!attribute || upper(issue.attribute) === upper(attribute)) &&
      (!wantedContexts.length || wantedContexts.includes(upper(issue.reportingContext)))
    );
    if (!matched) continue;
    const offerId = productOfferId(product) || `(sin offerId #${seen.size})`;
    if (!seen.has(offerId)) seen.set(offerId, productRow(product));
  }
  return [...seen.values()];
}

export function crossReferenceOfferIds(listA = [], listB = []) {
  const idsA = new Set(listA.map(row => row.offerId));
  const idsB = new Set(listB.map(row => row.offerId));
  const both = [...idsA].filter(id => idsB.has(id));
  return { both: both.length, onlyA: idsA.size - both.length, onlyB: idsB.size - both.length };
}

export function countByInput(rows = [], dataSourceInputMap = new Map()) {
  const counts = {};
  for (const row of rows) {
    const input = dataSourceInputMap.get(row.dataSource) || '(desconocido)';
    counts[input] = (counts[input] || 0) + 1;
  }
  return counts;
}

export function buildDataSourceInputMap(dataSources = []) {
  const map = new Map();
  for (const source of dataSources) {
    if (source?.name) map.set(source.name, upper(source.input));
  }
  return map;
}

// Compara offer_id reales (no sólo cantidades) entre dos inputs de dataSource
// (por defecto AUTOFEED vs FILE): cuántos offer_id están sólo en uno, sólo en
// el otro, o en ambos — y para los que están en ambos, una muestra con
// precio/imagen/disponibilidad/título de cada lado para poder compararlos.
export function compareOfferIdsAcrossInputs(products = [], dataSourceInputMap = new Map(), inputsToCompare = ['AUTOFEED', 'FILE'], sampleSize = 10) {
  const [inputA, inputB] = inputsToCompare;
  const byInput = new Map(inputsToCompare.map(input => [input, new Map()]));
  for (const product of products) {
    const input = dataSourceInputMap.get(asText(product.dataSource));
    const bucket = byInput.get(input);
    if (!bucket) continue;
    const offerId = productOfferId(product);
    if (!offerId) continue;
    if (!bucket.has(offerId)) bucket.set(offerId, product);
  }
  const mapA = byInput.get(inputA);
  const mapB = byInput.get(inputB);
  const idsA = new Set(mapA.keys());
  const idsB = new Set(mapB.keys());
  const bothIds = [...idsA].filter(id => idsB.has(id));
  const onlyAIds = [...idsA].filter(id => !idsB.has(id));
  const onlyBIds = [...idsB].filter(id => !idsA.has(id));
  return {
    inputA,
    inputB,
    totalUniqueOfferIds: new Set([...idsA, ...idsB]).size,
    bothCount: bothIds.length,
    onlyACount: onlyAIds.length,
    onlyBCount: onlyBIds.length,
    sampleBoth: bothIds.slice(0, sampleSize).map(offerId => ({
      offerId,
      [inputA]: productRow(mapA.get(offerId)),
      [inputB]: productRow(mapB.get(offerId)),
    })),
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

async function requestJson(url, accessToken) {
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

async function listAll({ endpoint, arrayField, pageSize, accessToken }) {
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

function endpointError(error) {
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
  const publicFeed = await (async () => {
    try {
      const response = await fetch(feedUrl, { signal: AbortSignal.timeout(60_000) });
      const xml = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
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

  // Ampliación del diagnóstico: dynamicRemarketingUy de arriba sigue igual
  // (sesgado a un solo destino, a propósito, para no romper nada de lo que
  // ya lo consume) — esto agrega TODOS los reportingContext reales que la
  // API devolvió para Uruguay (Shopping ads, Free listings, Display ads,
  // cualquier otro), sin descartar ninguno.
  const reportingContextsUy = [...aggregateProductStatusesByContextUy(byName.aggregateProductStatuses.data || []).values()]
    .map(summary => finalizeContextSummary(summary, 30))
    .sort((a, b) => a.reportingContext.localeCompare(b.reportingContext));

  const dataSourcesWithCounts = joinDataSourceProductCounts(dataSources, products?.byDataSource || []);

  // Tercera ampliación (mismo PR): detalle producto por producto de los
  // bloqueos prioritarios (image_too_small, precio faltante, ebooks,
  // landing pages) y el cruce real de offer_id entre AUTOFEED y FILE — todo
  // en memoria sobre los mismos productos ya leídos por products.list.
  const rawProducts = byName.products.data || [];
  const dataSourceInputMap = buildDataSourceInputMap(dataSources);
  const shoppingFreeContexts = ['SHOPPING_ADS', 'FREE_LISTINGS'];

  const imageTooSmall = listProductsByIssueCode(rawProducts, { code: 'image_too_small', contexts: shoppingFreeContexts });
  const missingPrice = listProductsByIssueCode(rawProducts, { code: 'item_missing_required_attribute', attribute: 'price', contexts: shoppingFreeContexts });
  const ebooks = listProductsByIssueCode(rawProducts, { code: 'ebooks_policy_violation', contexts: ['SHOPPING_ADS'] });
  const landingPendingCrawl = listProductsByIssueCode(rawProducts, { code: 'landing_page_pending_crawl', contexts: shoppingFreeContexts });
  const landingError = listProductsByIssueCode(rawProducts, { code: 'landing_page_error', contexts: shoppingFreeContexts });

  // Cuarta ampliación (mismo PR): reconciliación por identidad real
  // (link/GTIN) entre AUTOFEED y FILE — offer_id distinto puede ser el
  // mismo libro. Se construye una vez sobre TODOS los productos ya leídos
  // (no sólo los bloqueados) y se usa además para marcar, dentro de cada
  // lista de bloqueos AUTOFEED, si el producto ya tiene un gemelo en FILE.
  const allProductRows = rawProducts.map(productRow);
  const rowsByInput = input => allProductRows.filter(row => dataSourceInputMap.get(row.dataSource) === input);
  const autofeedRows = rowsByInput('AUTOFEED');
  const fileRows = rowsByInput('FILE');
  const fileIdentityIndex = buildIdentityIndex(fileRows);
  const identityReconciliation = reconcileIdentity(autofeedRows, fileIdentityIndex, 20);

  const withFileTwin = rows => rows.map(row => ({ ...row, fileTwin: findTwin(row, fileIdentityIndex) }));
  const imageTooSmallWithTwin = withFileTwin(imageTooSmall);
  const missingPriceWithTwin = withFileTwin(missingPrice);

  const productBreakdown = {
    imageTooSmall: imageTooSmallWithTwin,
    imageTooSmallByInput: countByInput(imageTooSmall, dataSourceInputMap),
    missingPrice: missingPriceWithTwin,
    missingPriceByInput: countByInput(missingPrice, dataSourceInputMap),
    overlapImageTooSmallVsMissingPrice: crossReferenceOfferIds(imageTooSmall, missingPrice),
    ebooks,
    landingPendingCrawl,
    landingError,
    autofeedVsFile: compareOfferIdsAcrossInputs(rawProducts, dataSourceInputMap, ['AUTOFEED', 'FILE'], 10),
    identityReconciliationAutofeedVsFile: identityReconciliation,
  };

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    accountId,
    alert,
    publicFeed,
    endpoints: endpoints.map(row => ({ name: row.name, ok: row.ok, error: row.error })),
    dataSources,
    dataSourcesWithProductCounts: dataSourcesWithCounts,
    accountIssues,
    aggregateStatuses: byName.aggregateProductStatuses.ok ? byName.aggregateProductStatuses.data : null,
    dynamicRemarketingUy,
    reportingContextsUy,
    productBreakdown,
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

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, 'merchant-readonly-report.json'), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(path.join(outputDir, 'report-summary.md'), reportMarkdown(report)),
    writeFile(path.join(outputDir, 'account-issues.json'), `${JSON.stringify(accountIssues, null, 2)}\n`),
    writeFile(path.join(outputDir, 'data-sources.json'), `${JSON.stringify(dataSources, null, 2)}\n`),
  ]);

  console.log(JSON.stringify({
    accountId,
    publicFeedItems: publicFeed.items,
    dynamicRemarketingUy,
    processedProducts: products?.processed ?? null,
    endpointFailures: endpoints.filter(row => !row.ok).map(row => row.name),
  }));

  // Diagnóstico ampliado — un bloque por sección, para que quede legible
  // directamente en el log del job (el artifact no siempre es accesible
  // desde todos lados; el log del run sí). Top 15 issues por contexto, tal
  // como se pidió — el archivo JSON completo (arriba) conserva hasta 30.
  console.log('=== REPORTING CONTEXTS (Uruguay) ===');
  console.log(JSON.stringify(
    reportingContextsUy.map(context => ({ ...context, topIssues: context.topIssues.slice(0, 15) })),
    null,
    2
  ));

  console.log('=== DATA SOURCES ===');
  console.log(JSON.stringify(
    dataSourcesWithCounts.map(source => ({
      displayName: source.displayName,
      type: source.type,
      input: source.input,
      dataSourceId: source.dataSourceId,
      productCount: source.productCount,
    })),
    null,
    2
  ));

  console.log('=== ACCOUNT ISSUES ===');
  console.log(JSON.stringify({
    total: accountIssues.length,
    issues: accountIssues.map(accountIssueLogSummary),
  }, null, 2));

  // Cuarta sección de stdout: detalle producto por producto de los bloqueos
  // prioritarios. Sin PII — son atributos de catálogo (offer_id, título,
  // imagen, precio), no datos de compradores.
  console.log('=== IMAGE_TOO_SMALL (producto por producto) ===');
  console.log(JSON.stringify({ count: imageTooSmallWithTwin.length, byInput: productBreakdown.imageTooSmallByInput, products: imageTooSmallWithTwin }, null, 2));

  console.log('=== MISSING PRICE (producto por producto) ===');
  console.log(JSON.stringify({ count: missingPriceWithTwin.length, byInput: productBreakdown.missingPriceByInput, products: missingPriceWithTwin }, null, 2));

  console.log('=== CRUCE image_too_small vs missing_price ===');
  console.log(JSON.stringify(productBreakdown.overlapImageTooSmallVsMissingPrice, null, 2));

  console.log('=== AUTOFEED vs FILE por offer_id ===');
  console.log(JSON.stringify(productBreakdown.autofeedVsFile, null, 2));

  console.log('=== RECONCILIACIÓN DE IDENTIDAD AUTOFEED vs FILE (link/GTIN, no offer_id) ===');
  console.log(JSON.stringify(identityReconciliation, null, 2));

  console.log('=== EBOOKS policy violation (SHOPPING_ADS) ===');
  console.log(JSON.stringify(ebooks, null, 2));

  console.log('=== LANDING PAGES ===');
  console.log(JSON.stringify({ pendingCrawl: landingPendingCrawl, error: landingError }, null, 2));

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
