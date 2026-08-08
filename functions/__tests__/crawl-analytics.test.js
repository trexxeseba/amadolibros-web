import test from 'node:test';
import assert from 'node:assert/strict';

import {
  USEFUL_CRAWL_RATIO_V1,
  classifyCrawlRequest,
  ipMatchesParsedRanges,
  isUsefulRatioDenominator,
  isUsefulRatioNumerator,
  parseCidr,
  recordCrawlRequest,
  resetCrawlAnalyticsCachesForTest,
  shouldCaptureCrawlRequest,
} from '../_shared/crawl-analytics.js';

const req = (path, headers = {}) => new Request(`https://www.amadolibros.com${path}`, { headers });

function fakeKv(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    async get(key) { return map.get(key) ?? null; },
    async put(key, value) { map.set(key, value); },
    map,
  };
}

function fakeDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        async run() {
          calls.push({ sql, args: [] });
          return { success: true };
        },
        bind(...args) {
          return {
            async run() {
              calls.push({ sql, args });
              return { success: true };
            },
          };
        },
      };
    },
  };
}

test('CIDR soporta IPv4 e IPv6', () => {
  const ranges = [
    parseCidr('66.249.64.0/19'),
    parseCidr('2001:4860:4801:10::/64'),
  ];

  assert.equal(ipMatchesParsedRanges('66.249.66.1', ranges), true);
  assert.equal(ipMatchesParsedRanges('8.8.8.8', ranges), false);
  assert.equal(ipMatchesParsedRanges('2001:4860:4801:10::1234', ranges), true);
  assert.equal(ipMatchesParsedRanges('2001:4860:4801:11::1', ranges), false);
  assert.equal(ipMatchesParsedRanges('ip-invalida', ranges), null);
});

test('clasifica URLs sin guardar el path como dimensión', () => {
  assert.deepEqual(classifyCrawlRequest(req('/?book=MLU123')), {
    pattern: 'legacy_book', legacy: true, contentPage: true, usefulCandidate: false,
  });
  assert.equal(classifyCrawlRequest(req('/page/94/?add-to-cart=1')).pattern, 'legacy_add_to_cart');
  assert.equal(classifyCrawlRequest(req('/libro/MLU123/un-libro')).pattern, 'libro');
  assert.equal(classifyCrawlRequest(req('/libros/psicologia?page=2')).pattern, 'libros');
  assert.equal(classifyCrawlRequest(req('/catalogo?q=tarot')).pattern, 'catalogo_param');
  assert.equal(classifyCrawlRequest(req('/_astro/app.abcdef.js')).pattern, 'asset');
});

test('captura siempre bots y legacy, pero solo 1% aproximado del resto', () => {
  const normal = req('/contacto', { 'user-agent': 'Mozilla/5.0' });
  const normalClass = classifyCrawlRequest(normal);
  assert.equal(shouldCaptureCrawlRequest(normal, normalClass, () => 0.009), true);
  assert.equal(shouldCaptureCrawlRequest(normal, normalClass, () => 0.5), false);

  const bot = req('/contacto', { 'user-agent': 'Googlebot/2.1' });
  assert.equal(shouldCaptureCrawlRequest(bot, classifyCrawlRequest(bot), () => 0.99), true);

  const legacy = req('/page/94/', { 'user-agent': 'Mozilla/5.0' });
  assert.equal(shouldCaptureCrawlRequest(legacy, classifyCrawlRequest(legacy), () => 0.99), true);
});

test('flag apagado corta antes de D1 y de verificar rangos', async () => {
  resetCrawlAnalyticsCachesForTest();
  const db = fakeDb();
  let fetched = false;
  const env = {
    APP_ENV: 'production',
    AMADO_KV: fakeKv({ 'seo:crawl-logs-3:enabled:production': 'false' }),
    ORDERS_DB: db,
  };
  const result = await recordCrawlRequest({
    request: req('/libro/MLU123/un-libro', {
      'user-agent': 'Googlebot/2.1',
      'cf-connecting-ip': '66.249.66.1',
    }),
    response: new Response('ok'),
    env,
  }, {
    fetchFn: async () => { fetched = true; throw new Error('no debe llamarse'); },
    nowFn: () => Date.parse('2026-08-08T13:00:00Z'),
  });

  assert.equal(result.recorded, false);
  assert.equal(result.reason, 'disabled');
  assert.equal(fetched, false);
  assert.equal(db.calls.length, 0);
});

test('Googlebot verificado se agrega sin persistir IP, UA ni path crudos', async () => {
  resetCrawlAnalyticsCachesForTest();
  const db = fakeDb();
  const kv = fakeKv({ 'seo:crawl-logs-3:enabled:production': 'true' });
  const env = { APP_ENV: 'production', AMADO_KV: kv, ORDERS_DB: db };
  const request = req('/libro/MLU123/un-libro', {
    'user-agent': 'Mozilla/5.0 compatible; Googlebot/2.1; +http://www.google.com/bot.html',
    'cf-connecting-ip': '66.249.66.1',
  });

  const result = await recordCrawlRequest({
    request,
    response: new Response('ok', { status: 200, headers: { 'content-length': '321' } }),
    env,
    durationMs: 12.5,
  }, {
    nowFn: () => Date.parse('2026-08-08T13:00:00Z'),
    fetchFn: async () => new Response(JSON.stringify({
      creationTime: '2026-08-08T00:00:00Z',
      prefixes: [
        { ipv4Prefix: '66.249.64.0/19' },
        { ipv6Prefix: '2001:4860:4801:10::/64' },
      ],
    }), { status: 200 }),
  });

  assert.equal(result.recorded, true);
  assert.equal(result.pattern, 'libro');
  assert.equal(result.verified, 1);
  assert.equal(result.usefulNumerator, true);
  assert.equal(result.usefulDenominator, true);

  const insert = db.calls.find(call => /INSERT INTO crawl_stats/.test(call.sql));
  assert.ok(insert);
  assert.deepEqual(insert.args.slice(0, 5), ['2026-08-08', 'libro', 200, 1, 1]);
  const persisted = JSON.stringify(insert.args);
  assert.equal(persisted.includes('66.249.66.1'), false);
  assert.equal(persisted.includes('Googlebot'), false);
  assert.equal(persisted.includes('/libro/MLU123/un-libro'), false);
});

test('UA Googlebot fuera de rangos oficiales queda no verificado', async () => {
  resetCrawlAnalyticsCachesForTest();
  const db = fakeDb();
  const env = {
    APP_ENV: 'production',
    AMADO_KV: fakeKv({ 'seo:crawl-logs-3:enabled:production': 'true' }),
    ORDERS_DB: db,
  };
  const result = await recordCrawlRequest({
    request: req('/contacto', {
      'user-agent': 'Googlebot/2.1',
      'cf-connecting-ip': '8.8.8.8',
    }),
    response: new Response('ok', { status: 200 }),
    env,
  }, {
    nowFn: () => Date.parse('2026-08-08T13:00:00Z'),
    fetchFn: async () => new Response(JSON.stringify({ prefixes: [{ ipv4Prefix: '66.249.64.0/19' }] }), { status: 200 }),
  });

  assert.equal(result.verified, 0);
  assert.equal(result.usefulNumerator, false);
  assert.equal(result.usefulDenominator, false);
});

test('definición useful_crawl_ratio_v1 queda congelada y excluye infraestructura', () => {
  assert.equal(USEFUL_CRAWL_RATIO_V1.version, 1);

  const useful = classifyCrawlRequest(req('/contacto'));
  assert.equal(isUsefulRatioNumerator({ classification: useful, status: 200, verified: 1 }), true);
  assert.equal(isUsefulRatioDenominator({ classification: useful, verified: 1 }), true);

  const legacy = classifyCrawlRequest(req('/page/94/'));
  assert.equal(isUsefulRatioNumerator({ classification: legacy, status: 410, verified: 1 }), false);
  assert.equal(isUsefulRatioDenominator({ classification: legacy, verified: 1 }), true);

  const sitemap = classifyCrawlRequest(req('/sitemap.xml'));
  assert.equal(isUsefulRatioDenominator({ classification: sitemap, verified: 1 }), false);
});
