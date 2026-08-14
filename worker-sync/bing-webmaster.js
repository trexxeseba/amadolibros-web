/**
 * Cliente de solo lectura para Bing Webmaster Tools.
 *
 * Usa exclusivamente el protocolo REST/JSON. La API key se lee del secret
 * BING_WEBMASTER_API_KEY y nunca se registra ni se devuelve al cliente.
 * La propiedad queda fijada al dominio canónico verificado.
 */

export const BING_WEBMASTER_API_BASE =
  'https://ssl.bing.com/webmaster/api.svc/json';
export const BING_WEBMASTER_SITE_URL = 'https://www.amadolibros.com';
export const BING_WEBMASTER_READ_METHODS = Object.freeze([
  'GetCrawlIssues',
  'GetQueryStats',
  'GetUrlSubmissionQuota',
]);

const MAX_QUERY_ROWS = 100;
const MAX_CRAWL_ISSUES = 200;

export class BingWebmasterApiError extends Error {
  constructor(message, {
    code = 'BING_API_ERROR',
    httpStatus = null,
  } = {}) {
    super(message);
    this.name = 'BingWebmasterApiError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function buildBingWebmasterUrl(method, apiKey) {
  if (!BING_WEBMASTER_READ_METHODS.includes(method)) {
    throw new BingWebmasterApiError('Método de Bing no permitido.', {
      code: 'METHOD_NOT_ALLOWED',
    });
  }
  if (!apiKey || !String(apiKey).trim()) {
    throw new BingWebmasterApiError('BING_WEBMASTER_API_KEY no está configurada.', {
      code: 'MISSING_API_KEY',
    });
  }

  const url = new URL(BING_WEBMASTER_API_BASE + '/' + method);
  url.searchParams.set('apikey', String(apiKey).trim());
  url.searchParams.set('siteUrl', BING_WEBMASTER_SITE_URL);
  return url;
}

export async function fetchBingWebmasterMethod(method, env, {
  fetchFn = fetch,
  signal,
} = {}) {
  const apiKey = env?.BING_WEBMASTER_API_KEY;
  const url = buildBingWebmasterUrl(method, apiKey);

  let response;
  try {
    response = await fetchFn(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (error) {
    throw new BingWebmasterApiError(
      'No se pudo conectar con Bing Webmaster Tools.',
      { code: 'NETWORK_ERROR' },
    );
  }

  let payload;
  try {
    const text = await response.text();
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new BingWebmasterApiError(
      'Bing devolvió una respuesta que no es JSON válido.',
      {
        code: 'INVALID_JSON',
        httpStatus: response.status,
      },
    );
  }

  const apiError = payload?.ErrorCode != null
    ? payload
    : payload?.d?.ErrorCode != null
      ? payload.d
      : null;

  if (!response.ok || apiError) {
    const code = apiError?.ErrorCode != null
      ? 'BING_' + apiError.ErrorCode
      : 'HTTP_' + response.status;
    const message = apiError?.Message
      ? 'Bing rechazó la consulta: ' + String(apiError.Message).slice(0, 240)
      : 'Bing respondió con HTTP ' + response.status + '.';
    throw new BingWebmasterApiError(message, {
      code,
      httpStatus: response.status,
    });
  }

  return payload?.d ?? payload;
}

function bingDateToIso(value) {
  const match = String(value || '').match(/^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/);
  if (!match) return value || null;
  const date = new Date(Number(match[1]));
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row?.[key] ?? 'unknown';
    counts[String(value)] = (counts[String(value)] || 0) + 1;
  }
  return counts;
}

function normalizeQueryStats(value) {
  const rows = Array.isArray(value) ? value : [];
  const sorted = [...rows].sort((a, b) =>
    Number(b?.Impressions || 0) - Number(a?.Impressions || 0)
    || Number(b?.Clicks || 0) - Number(a?.Clicks || 0)
  );
  return {
    total_rows: rows.length,
    totals: {
      impressions: rows.reduce((sum, row) => sum + Number(row?.Impressions || 0), 0),
      clicks: rows.reduce((sum, row) => sum + Number(row?.Clicks || 0), 0),
    },
    rows: sorted.slice(0, MAX_QUERY_ROWS).map(row => ({
      query: String(row?.Query || ''),
      date: bingDateToIso(row?.Date),
      impressions: Number(row?.Impressions || 0),
      clicks: Number(row?.Clicks || 0),
      average_impression_position: finiteOrNull(row?.AvgImpressionPosition),
      average_click_position: finiteOrNull(row?.AvgClickPosition),
    })),
    truncated: rows.length > MAX_QUERY_ROWS,
    documented_update_frequency: 'weekly',
  };
}

function normalizeCrawlIssues(value) {
  const rows = Array.isArray(value) ? value : [];
  return {
    total: rows.length,
    by_http_code: countBy(rows, 'HttpCode'),
    by_issue_code: countBy(rows, 'Issues'),
    rows: rows.slice(0, MAX_CRAWL_ISSUES).map(row => ({
      url: String(row?.Url || ''),
      http_code: finiteOrNull(row?.HttpCode),
      issue_code: finiteOrNull(row?.Issues),
      inlinks: finiteOrNull(row?.InLinks),
    })),
    truncated: rows.length > MAX_CRAWL_ISSUES,
    limitation: 'No reemplaza el Site Scan SEO completo de Bing.',
  };
}

function normalizeQuota(value) {
  return {
    daily_quota: finiteOrNull(value?.DailyQuota),
    monthly_quota: finiteOrNull(value?.MonthlyQuota),
    informational_only: true,
    submissions_enabled: false,
  };
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicError(error) {
  return {
    code: error?.code || 'BING_API_ERROR',
    message: String(error?.message || 'Error consultando Bing.').slice(0, 300),
    http_status: Number.isInteger(error?.httpStatus) ? error.httpStatus : null,
  };
}

export async function getBingWebmasterReadOnlySummary(env, {
  fetchFn = fetch,
} = {}) {
  const methods = BING_WEBMASTER_READ_METHODS;
  const results = await Promise.allSettled(
    methods.map(method => fetchBingWebmasterMethod(method, env, { fetchFn })),
  );
  const byMethod = Object.fromEntries(
    methods.map((method, index) => [method, results[index]]),
  );
  const fulfilled = results.filter(result => result.status === 'fulfilled').length;
  const status = fulfilled === results.length
    ? 'ok'
    : fulfilled > 0
      ? 'partial'
      : 'error';

  const valueOrError = (method, normalize) => {
    const result = byMethod[method];
    return result.status === 'fulfilled'
      ? { status: 'ok', ...normalize(result.value) }
      : { status: 'error', error: publicError(result.reason) };
  };

  return {
    status,
    checked_at: new Date().toISOString(),
    site_url: BING_WEBMASTER_SITE_URL,
    protocol: 'rest-json',
    read_only: true,
    query_performance: valueOrError('GetQueryStats', normalizeQueryStats),
    crawl_issues: valueOrError('GetCrawlIssues', normalizeCrawlIssues),
    url_submission_quota: valueOrError('GetUrlSubmissionQuota', normalizeQuota),
    limitations: {
      replaces_keyword_research: false,
      replaces_full_site_scan: false,
      submit_url_batch_enabled: false,
    },
  };
}
