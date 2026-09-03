#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const TAROT_QUERY = /(tarot|or[áa]culo|rider[ -]?waite|marsella|baraja adivinatoria|mazo de cartas)/i;
const TAROT_URL = /(\/libros\/esoterismo-tarot|tarot|oraculo|oráculo|rider-waite|marsella)/i;
const BIBLE_QUERY = /(biblia|reina[ -]?valera|rvr[ -]?(1960|60)|rvc|nvi|ntv|dhh|jerusal[ée]n|latinoamericana|nuevo testamento)/i;
const BIBLE_URL = /(biblia|reina-valera|rvr-?(1960|60)|jerusalen|latinoamericana|nuevo-testamento)/i;

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boolean(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

export function classifyVertical(row) {
  const query = String(row.query ?? '');
  const url = String(row.url ?? '');
  if (TAROT_QUERY.test(query) || TAROT_URL.test(url)) return 'tarot';
  if (BIBLE_QUERY.test(query) || BIBLE_URL.test(url)) return 'biblias';
  return null;
}

function normalizeRow(row) {
  return {
    dataDate: String(row.data_date ?? ''),
    siteUrl: String(row.site_url ?? ''),
    searchType: String(row.search_type ?? ''),
    url: String(row.url ?? ''),
    query: String(row.query ?? ''),
    isAnonymizedQuery: boolean(row.is_anonymized_query),
    country: String(row.country ?? ''),
    device: String(row.device ?? ''),
    clicks: number(row.clicks),
    impressions: number(row.impressions),
    sumPosition: number(row.sum_position)
  };
}

function addMetric(target, row) {
  target.clicks += row.clicks;
  target.impressions += row.impressions;
  target.sumPosition += row.sumPosition;
}

function finishMetric(target) {
  return {
    clicks: target.clicks,
    impressions: target.impressions,
    ctr: target.impressions ? target.clicks / target.impressions : 0,
    average_position: target.impressions ? target.sumPosition / target.impressions + 1 : null
  };
}

function blankMetric(extra = {}) {
  return { ...extra, clicks: 0, impressions: 0, sumPosition: 0 };
}

function dateMinus(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function groupByKey(map, key, factory) {
  if (!map.has(key)) map.set(key, factory());
  return map.get(key);
}

function sortMetrics(rows) {
  return rows.sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || (a.average_position ?? Infinity) - (b.average_position ?? Infinity));
}

export function analyzeWindow(rows, { days, minDate, maxDate, minImpressions }) {
  const requestedStartDate = dateMinus(maxDate, days - 1);
  const startDate = minDate && minDate > requestedStartDate ? minDate : requestedStartDate;
  const selected = rows.filter(row => row.dataDate >= startDate && row.dataDate <= maxDate);
  const observedDataDays = new Set(selected.map(row => row.dataDate)).size;
  const summary = new Map();
  const queries = new Map();
  const pages = new Map();
  const queryPages = new Map();

  for (const row of selected) {
    const vertical = classifyVertical(row);
    if (!vertical) continue;

    const summaryRow = groupByKey(summary, vertical, () => blankMetric({ vertical, urls: new Set(), queries: new Set(), dates: new Set() }));
    addMetric(summaryRow, row);
    if (row.url) summaryRow.urls.add(row.url);
    if (row.query && !row.isAnonymizedQuery) summaryRow.queries.add(row.query);
    if (row.dataDate) summaryRow.dates.add(row.dataDate);

    if (row.url) {
      const key = JSON.stringify([vertical, row.url]);
      const page = groupByKey(pages, key, () => blankMetric({ vertical, url: row.url, queries: new Set() }));
      addMetric(page, row);
      if (row.query && !row.isAnonymizedQuery) page.queries.add(row.query);
    }

    if (!row.isAnonymizedQuery && row.query) {
      const queryKey = JSON.stringify([vertical, row.query, row.country, row.device]);
      addMetric(groupByKey(queries, queryKey, () => blankMetric({ vertical, query: row.query, country: row.country, device: row.device })), row);
      if (row.url) {
        const queryPageKey = JSON.stringify([vertical, row.query, row.url]);
        addMetric(groupByKey(queryPages, queryPageKey, () => blankMetric({ vertical, query: row.query, url: row.url })), row);
      }
    }
  }

  const summaryRows = [...summary.values()].map(row => ({
    vertical: row.vertical,
    ...finishMetric(row),
    urls: row.urls.size,
    queries: row.queries.size,
    data_days: row.dates.size
  })).sort((a, b) => a.vertical.localeCompare(b.vertical));

  const queryRows = sortMetrics([...queries.values()].map(row => ({ ...row, ...finishMetric(row) })))
    .filter(row => row.impressions >= minImpressions && row.average_position >= 4 && row.average_position <= 20)
    .slice(0, 1000)
    .map(({ sumPosition, ...row }) => row);

  const pageRows = sortMetrics([...pages.values()].map(row => ({
    vertical: row.vertical,
    url: row.url,
    ...finishMetric(row),
    queries: row.queries.size
  }))).slice(0, 2000);

  const cannibalizationGroups = new Map();
  for (const row of queryPages.values()) {
    const key = JSON.stringify([row.vertical, row.query]);
    const group = groupByKey(cannibalizationGroups, key, () => blankMetric({ vertical: row.vertical, query: row.query, urls: [] }));
    addMetric(group, row);
    group.urls.push({ url: row.url, impressions: row.impressions });
  }
  const cannibalizationRows = sortMetrics([...cannibalizationGroups.values()]
    .filter(row => row.urls.length > 1 && row.impressions >= minImpressions)
    .map(row => ({
      vertical: row.vertical,
      query: row.query,
      url_count: row.urls.length,
      ...finishMetric(row),
      top_urls: row.urls.sort((a, b) => b.impressions - a.impressions).slice(0, 5).map(item => item.url).join(' | ')
    }))).slice(0, 500);

  return {
    days,
    requestedStartDate,
    startDate,
    endDate: maxDate,
    observedDataDays,
    fullCalendarRangeAvailable: startDate === requestedStartDate,
    summaryRows,
    queryRows,
    pageRows,
    cannibalizationRows
  };
}

function safeCsv(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return `${headers.map(safeCsv).join(',')}\n${rows.map(row => headers.map(header => safeCsv(row[header])).join(',')).join('\n')}\n`;
}

async function writeReport(outputDir, window, availability) {
  const windowDir = path.join(outputDir, `${window.days}d`);
  await mkdir(windowDir, { recursive: true });
  const reports = {
    summary: window.summaryRows,
    queries: window.queryRows,
    pages: window.pageRows,
    cannibalization: window.cannibalizationRows
  };
  for (const [name, rows] of Object.entries(reports)) {
    await writeFile(path.join(windowDir, `vertical-${name}.json`), `${JSON.stringify(rows, null, 2)}\n`);
    await writeFile(path.join(windowDir, `vertical-${name}.csv`), csv(rows));
  }
  await writeFile(path.join(windowDir, 'metadata.json'), `${JSON.stringify({
    windowDays: window.days,
    requestedRange: { startDate: window.requestedStartDate, endDate: window.endDate },
    effectiveRange: { startDate: window.startDate, endDate: window.endDate },
    observedDataDays: window.observedDataDays,
    fullCalendarRangeAvailable: window.fullCalendarRangeAvailable,
    availableRange: availability
  }, null, 2)}\n`);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value == null) throw new Error(`Argumento inválido: ${key ?? ''}`);
    values[key.slice(2)] = value;
  }
  return values;
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const required = ['input', 'output', 'site', 'table', 'min-impressions', 'table-row-count'];
  for (const name of required) if (!args[name]) throw new Error(`Falta --${name}`);
  const minImpressions = number(args['min-impressions']);
  if (!Number.isInteger(minImpressions) || minImpressions < 1) throw new Error('--min-impressions debe ser un entero positivo');

  const rawRows = JSON.parse(await readFile(args.input, 'utf8'));
  if (!Array.isArray(rawRows)) throw new Error('La lectura BigQuery no devolvió un array');
  const rows = rawRows.map(normalizeRow).filter(row => row.siteUrl === args.site && row.searchType === 'web' && /^\d{4}-\d{2}-\d{2}$/.test(row.dataDate));
  if (!rows.length) throw new Error(`No hay filas web para ${args.site}`);

  const dates = [...new Set(rows.map(row => row.dataDate))].sort();
  const availability = {
    minDate: dates[0],
    maxDate: dates.at(-1),
    days: dates.length,
    tableRows: number(args['table-row-count']),
    usableWebRows: rows.length,
    partitionExpirationDays: number(args['partition-expiration-ms']) > 0
      ? number(args['partition-expiration-ms']) / 86400000
      : null
  };
  await mkdir(args.output, { recursive: true });
  await writeFile(path.join(args.output, 'availability.json'), `${JSON.stringify(availability, null, 2)}\n`);

  const windows = [28, 90].map(days => analyzeWindow(rows, {
    days,
    minDate: availability.minDate,
    maxDate: availability.maxDate,
    minImpressions
  }));
  for (const window of windows) await writeReport(args.output, window, availability);

  const lines = [
    '# GSC BigQuery — Tarot y Biblias',
    '',
    `- Propiedad: \`${args.site}\``,
    `- Tabla: \`${args.table}\``,
    `- Datos disponibles: **${availability.minDate} a ${availability.maxDate}** (${availability.days} días; ${availability.usableWebRows} filas web de ${availability.tableRows} totales)`,
    '- Ventanas solicitadas: 28 y 90 días, recortadas automáticamente a los datos realmente disponibles.',
    availability.partitionExpirationDays
      ? `- Retención configurada de particiones: ${availability.partitionExpirationDays} días.`
      : '- Retención configurada de particiones: no informada.',
    `- Oportunidades: posición 4–20 y al menos ${minImpressions} impresiones.`,
    '- Acceso BigQuery: metadatos + tabledata de sólo lectura; no crea query jobs.',
    ''
  ];
  for (const window of windows) {
    lines.push(`## Ventana solicitada: ${window.days} días`, '');
    lines.push(`- Cobertura efectiva: ${window.startDate} a ${window.endDate} (${window.observedDataDays} fechas con datos).`);
    if (!window.fullCalendarRangeAvailable) {
      lines.push(`- Advertencia: todavía no hay ${window.days} días calendario disponibles; no comparar este corte como una ventana completa.`);
    }
    if (availability.partitionExpirationDays && window.days > availability.partitionExpirationDays) {
      lines.push(`- Advertencia de retención: la política actual de ${availability.partitionExpirationDays} días impide conservar una ventana completa de ${window.days} días cuando madure el histórico.`);
    }
    lines.push('');
    if (!window.summaryRows.length) lines.push('- Sin filas clasificadas para Tarot o Biblias.');
    for (const row of window.summaryRows) {
      lines.push(`- ${row.vertical}: ${row.clicks} clics, ${row.impressions} impresiones, CTR ${(row.ctr * 100).toFixed(2)}%, posición media ${row.average_position.toFixed(1)}, ${row.urls} URLs, ${row.data_days} días con datos.`);
    }
    lines.push('', `- Queries accionables: ${window.queryRows.length}`, `- Posibles canibalizaciones: ${window.cannibalizationRows.length}`, '');
  }
  lines.push('> Informe de sólo lectura. No modifica Search Console, BigQuery, la web, Merchant ni producción.');
  const summary = `${lines.join('\n')}\n`;
  await writeFile(path.join(args.output, 'summary.md'), summary);
  process.stdout.write(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  });
}
