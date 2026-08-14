import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BING_WEBMASTER_API_BASE,
  BING_WEBMASTER_READ_METHODS,
  BING_WEBMASTER_SITE_URL,
  buildBingWebmasterUrl,
  fetchBingWebmasterMethod,
  getBingWebmasterReadOnlySummary,
} from '../bing-webmaster.js';

const API_KEY = 'bing-test-key';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('construye únicamente URLs REST/JSON para la propiedad canónica con www', () => {
  const url = buildBingWebmasterUrl('GetQueryStats', API_KEY);

  assert.equal(url.origin + url.pathname, BING_WEBMASTER_API_BASE + '/GetQueryStats');
  assert.equal(url.searchParams.get('siteUrl'), BING_WEBMASTER_SITE_URL);
  assert.equal(url.searchParams.get('apikey'), API_KEY);
  assert.doesNotMatch(url.pathname, /\/pox\/|\/soap\//);
});

test('rechaza métodos de escritura y no llama a la red sin secret', async () => {
  assert.throws(
    () => buildBingWebmasterUrl('SubmitUrlBatch', API_KEY),
    /Método de Bing no permitido/,
  );

  let calls = 0;
  await assert.rejects(
    () => fetchBingWebmasterMethod('GetCrawlIssues', {}, {
      fetchFn: async () => {
        calls++;
        return jsonResponse({ d: [] });
      },
    }),
    error => error.code === 'MISSING_API_KEY',
  );
  assert.equal(calls, 0);
});

test('consulta por GET y desenvuelve el campo d del protocolo JSON', async () => {
  let captured;
  const data = await fetchBingWebmasterMethod(
    'GetUrlSubmissionQuota',
    { BING_WEBMASTER_API_KEY: API_KEY },
    {
      fetchFn: async (url, options) => {
        captured = { url, options };
        return jsonResponse({
          d: {
            __type: 'UrlSubmissionQuota:#Microsoft.Bing.Webmaster.Api',
            DailyQuota: 5,
            MonthlyQuota: 24,
          },
        });
      },
    },
  );

  assert.equal(captured.options.method, 'GET');
  assert.equal(new URL(captured.url).searchParams.get('siteUrl'), BING_WEBMASTER_SITE_URL);
  assert.equal(data.DailyQuota, 5);
  assert.equal(data.MonthlyQuota, 24);
});

test('convierte el ErrorCode documentado de Bing en un error controlado', async () => {
  await assert.rejects(
    () => fetchBingWebmasterMethod(
      'GetQueryStats',
      { BING_WEBMASTER_API_KEY: API_KEY },
      {
        fetchFn: async () => jsonResponse({
          ErrorCode: 3,
          Message: 'InvalidApiKey',
        }),
      },
    ),
    error => error.code === 'BING_3' && /InvalidApiKey/.test(error.message),
  );
});

test('el resumen llama exactamente los tres métodos de lectura y normaliza resultados', async () => {
  const calls = [];
  const fetchFn = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    const method = url.pathname.split('/').at(-1);
    calls.push({ method, options, siteUrl: url.searchParams.get('siteUrl') });

    if (method === 'GetQueryStats') {
      return jsonResponse({
        d: [{
          Query: 'libros de psicología uruguay',
          Date: '/Date(1786665600000)/',
          Impressions: 12,
          Clicks: 3,
          AvgImpressionPosition: 8,
          AvgClickPosition: 6,
        }],
      });
    }
    if (method === 'GetCrawlIssues') {
      return jsonResponse({
        d: [{
          Url: 'https://www.amadolibros.com/libro/MLU1/libro',
          HttpCode: 404,
          Issues: 1,
          InLinks: 4,
        }],
      });
    }
    return jsonResponse({ d: { DailyQuota: 5, MonthlyQuota: 24 } });
  };

  const result = await getBingWebmasterReadOnlySummary(
    { BING_WEBMASTER_API_KEY: API_KEY },
    { fetchFn },
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.read_only, true);
  assert.equal(result.site_url, BING_WEBMASTER_SITE_URL);
  assert.deepEqual(
    calls.map(call => call.method).sort(),
    [...BING_WEBMASTER_READ_METHODS].sort(),
  );
  assert.ok(calls.every(call => call.options.method === 'GET'));
  assert.ok(calls.every(call => call.siteUrl === BING_WEBMASTER_SITE_URL));
  assert.equal(result.query_performance.totals.impressions, 12);
  assert.equal(result.query_performance.totals.clicks, 3);
  assert.equal(result.crawl_issues.by_http_code['404'], 1);
  assert.equal(result.url_submission_quota.daily_quota, 5);
  assert.equal(result.url_submission_quota.submissions_enabled, false);
  assert.equal(result.limitations.replaces_keyword_research, false);
  assert.equal(result.limitations.replaces_full_site_scan, false);
  assert.equal(result.limitations.submit_url_batch_enabled, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(API_KEY));
});

test('una falla parcial queda visible sin ocultar los otros datos', async () => {
  const fetchFn = async rawUrl => {
    const method = new URL(rawUrl).pathname.split('/').at(-1);
    if (method === 'GetCrawlIssues') {
      return jsonResponse({ ErrorCode: 3, Message: 'InvalidApiKey' });
    }
    if (method === 'GetQueryStats') return jsonResponse({ d: [] });
    return jsonResponse({ d: { DailyQuota: 2, MonthlyQuota: 9 } });
  };

  const result = await getBingWebmasterReadOnlySummary(
    { BING_WEBMASTER_API_KEY: API_KEY },
    { fetchFn },
  );

  assert.equal(result.status, 'partial');
  assert.equal(result.crawl_issues.status, 'error');
  assert.equal(result.crawl_issues.error.code, 'BING_3');
  assert.equal(result.query_performance.status, 'ok');
  assert.equal(result.url_submission_quota.status, 'ok');
});

test('la configuración declara la API key únicamente como secret', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const wrangler = readFileSync(root + '/wrangler.toml', 'utf8');
  const source = readFileSync(root + '/index.js', 'utf8');

  assert.match(wrangler, /BING_WEBMASTER_API_KEY\s+—\s+secret de la API/);
  assert.doesNotMatch(wrangler, /BING_WEBMASTER_API_KEY\s*=\s*['"]/);
  assert.match(source, /GET \/bing-webmaster\/summary/);
  assert.match(source, /getBingWebmasterReadOnlySummary\(env\)/);
  assert.doesNotMatch(source, /SubmitUrlBatch/);
});
