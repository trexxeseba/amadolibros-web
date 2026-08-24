import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ADMIN_BASE = 'https://analyticsadmin.googleapis.com/v1beta';
const DATA_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const TARGET_MEASUREMENT_ID = 'G-SDX45VEPP3';
const OBSERVED_MEASUREMENT_ID = 'G-XLXDM89KGE';
const TARGET_ADS_CUSTOMER_ID = '7156858182';

function cleanAdsId(value) {
  return String(value || '').replace(/\D/g, '');
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function reportCell(report, field) {
  const values = report?.rows?.[0]?.[field];
  return values?.[0]?.value || '';
}

function classify(row) {
  if (row.isTarget && row.inspectionErrors.length) {
    return 'KEEP_PRODUCTION_TARGET_REVIEW_INCOMPLETE';
  }
  if (row.isTarget) return 'KEEP_PRODUCTION_TARGET';
  if (row.inspectionErrors.length) return 'REVIEW_INSPECTION_INCOMPLETE';
  if (Number(row.purchases90d || 0) > 0) return 'REVIEW_HAS_PURCHASES';
  if (Number(row.events30d || 0) > 0) return 'REVIEW_ACTIVE';
  if (row.lastActivityDate365d) return 'REVIEW_HISTORICAL_DATA';
  if (row.isObserved) return 'REVIEW_OBSERVED_MEASUREMENT_ID';
  if (!row.streams.length) return 'CANDIDATE_NO_STREAM';
  return 'CANDIDATE_NO_ACTIVITY_365D';
}

async function requestJson(url, { token, method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${url} ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function listAll(path, field, token) {
  const output = [];
  let pageToken = '';
  do {
    const url = new URL(`${ADMIN_BASE}/${path}`);
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const payload = await requestJson(url, { token });
    output.push(...(payload[field] || []));
    pageToken = payload.nextPageToken || '';
  } while (pageToken);
  return output;
}

async function safe(label, errors, action, fallback) {
  try {
    return await action();
  } catch (error) {
    errors.push(`${label}: ${error.message}`);
    return fallback;
  }
}

async function runReport(property, token, body) {
  return requestJson(`${DATA_BASE}/${property}:runReport`, {
    token,
    method: 'POST',
    body,
  });
}

async function activityFor(property, token, errors) {
  const last = await safe(`${property}:lastActivity`, errors, () => runReport(property, token, {
    dateRanges: [{ startDate: '365daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'eventCount' }],
    orderBys: [{ dimension: { dimensionName: 'date' }, desc: true }],
    limit: '1',
  }), {});
  const events = await safe(`${property}:events30d`, errors, () => runReport(property, token, {
    dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
    metrics: [{ name: 'eventCount' }],
  }), {});
  const purchases = await safe(`${property}:purchases90d`, errors, () => runReport(property, token, {
    dateRanges: [{ startDate: '90daysAgo', endDate: 'today' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        stringFilter: { matchType: 'EXACT', value: 'purchase', caseSensitive: true },
      },
    },
  }), {});
  return {
    lastActivityDate365d: reportCell(last, 'dimensionValues'),
    events30d: reportCell(events, 'metricValues') || '0',
    purchases90d: reportCell(purchases, 'metricValues') || '0',
  };
}

async function inspectProperty(account, summary, token) {
  const property = summary.property;
  const errors = [];
  const details = await safe(`${property}:get`, errors,
    () => requestJson(`${ADMIN_BASE}/${property}`, { token }), {});
  const streams = await safe(`${property}:streams`, errors,
    () => listAll(`${property}/dataStreams`, 'dataStreams', token), []);
  const adsLinks = await safe(`${property}:googleAdsLinks`, errors,
    () => listAll(`${property}/googleAdsLinks`, 'googleAdsLinks', token), []);
  const keyEvents = await safe(`${property}:keyEvents`, errors,
    () => listAll(`${property}/keyEvents`, 'keyEvents', token), []);
  const activity = await activityFor(property, token, errors);
  const measurementIds = streams
    .map((stream) => stream.webStreamData?.measurementId)
    .filter(Boolean);
  const streamUrls = streams
    .map((stream) => stream.webStreamData?.defaultUri)
    .filter(Boolean);
  const adsIds = adsLinks.map((link) => cleanAdsId(link.customerId)).filter(Boolean);

  const row = {
    accountId: String(account.account || '').replace('accounts/', ''),
    accountName: account.displayName || '',
    propertyId: String(property || '').replace('properties/', ''),
    propertyName: details.displayName || summary.displayName || '',
    propertyType: details.propertyType || summary.propertyType || '',
    parent: details.parent || summary.parent || '',
    canEdit: summary.canEdit === true,
    streams,
    streamUrls,
    measurementIds,
    isTarget: measurementIds.includes(TARGET_MEASUREMENT_ID),
    isObserved: measurementIds.includes(OBSERVED_MEASUREMENT_ID),
    lastActivityDate365d: activity.lastActivityDate365d,
    events30d: activity.events30d,
    purchases90d: activity.purchases90d,
    purchaseIsKeyEvent: keyEvents.some((event) => event.eventName === 'purchase'),
    adsCustomerIds: adsIds,
    isLinkedToTargetAds: adsIds.includes(TARGET_ADS_CUSTOMER_ID),
    inspectionErrors: errors,
  };
  row.classification = classify(row);
  return row;
}

function toCsv(rows) {
  const headers = [
    'account_id', 'account_name', 'property_id', 'property_name', 'property_type',
    'parent', 'can_edit', 'stream_urls', 'measurement_ids',
    'is_target_G_SDX45VEPP3', 'is_observed_G_XLXDM89KGE',
    'last_activity_date_365d', 'events_30d', 'purchases_90d',
    'purchase_is_key_event', 'google_ads_customer_ids',
    'is_linked_to_7156858182', 'inspection_errors', 'classification',
  ];
  const values = rows.map((row) => [
    row.accountId, row.accountName, row.propertyId, row.propertyName, row.propertyType,
    row.parent, row.canEdit, row.streamUrls.join(' | '), row.measurementIds.join(' | '),
    row.isTarget, row.isObserved, row.lastActivityDate365d, row.events30d,
    row.purchases90d, row.purchaseIsKeyEvent, row.adsCustomerIds.join(' | '),
    row.isLinkedToTargetAds, row.inspectionErrors.join(' | '), row.classification,
  ]);
  return [headers, ...values].map((line) => line.map(csvCell).join(',')).join('\n') + '\n';
}

function summaryMarkdown(rows, globalErrors) {
  const target = rows.filter((row) => row.isTarget);
  const observed = rows.filter((row) => row.isObserved);
  const active = rows.filter((row) => Number(row.events30d || 0) > 0);
  const purchases = rows.filter((row) => Number(row.purchases90d || 0) > 0);
  const incomplete = rows.filter((row) => row.inspectionErrors.length);
  return [
    '# GA4 admin audit — read only',
    '',
    `- Accessible properties: ${rows.length}`,
    `- Production target ${TARGET_MEASUREMENT_ID}: ${target.length}`,
    `- Observed ID ${OBSERVED_MEASUREMENT_ID}: ${observed.length}`,
    `- Active in last 30 days: ${active.length}`,
    `- With purchase events in last 90 days: ${purchases.length}`,
    `- Linked to Ads 715-685-8182: ${rows.filter((row) => row.isLinkedToTargetAds).length}`,
    `- Incomplete inspections: ${incomplete.length}`,
    `- Global errors: ${globalErrors.length}`,
    '',
    'No resource was created, modified, linked or deleted.',
  ].join('\n') + '\n';
}

async function main() {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  const outputDir = process.env.GA4_ADMIN_OUTPUT_DIR || 'artifacts/ga4-admin-audit';
  if (!token) throw new Error('Falta GOOGLE_ACCESS_TOKEN.');

  const globalErrors = [];
  const accounts = await listAll('accountSummaries', 'accountSummaries', token);
  const rows = [];
  for (const account of accounts) {
    for (const property of account.propertySummaries || []) {
      rows.push(await inspectProperty(account, property, token));
    }
  }

  if (!accounts.length) {
    globalErrors.push('La identidad de Google no puede ver ninguna cuenta de Analytics.');
  } else if (!rows.length) {
    globalErrors.push('La identidad de Google ve cuentas, pero ninguna propiedad GA4.');
  }

  await mkdir(outputDir, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY',
    targetMeasurementId: TARGET_MEASUREMENT_ID,
    observedMeasurementId: OBSERVED_MEASUREMENT_ID,
    targetAdsCustomerId: TARGET_ADS_CUSTOMER_ID,
    globalErrors,
    rows,
  };
  await writeFile(`${outputDir}/inventory.json`, JSON.stringify(payload, null, 2) + '\n');
  await writeFile(`${outputDir}/inventory.csv`, toCsv(rows));
  await writeFile(`${outputDir}/summary.md`, summaryMarkdown(rows, globalErrors));
  process.stdout.write(summaryMarkdown(rows, globalErrors));
}

export { classify, cleanAdsId, csvCell, summaryMarkdown, toCsv };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
