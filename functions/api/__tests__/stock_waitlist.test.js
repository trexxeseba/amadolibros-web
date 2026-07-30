import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStockWaitlistEmail,
  createStockWaitlistHandler,
} from '../_stock_waitlist_handler.js';

const NOW = new Date('2026-07-30T15:00:00.000Z');
const PAUSED = {
  id: 'MLU200',
  title: 'Libro <agotado>',
  status: 'paused',
  available_quantity: 0,
};
const ACTIVE = {
  id: 'MLU100',
  title: 'Libro disponible',
  status: 'active',
  available_quantity: 2,
};

function env(db, patch = {}) {
  return {
    APP_ENV: 'preview',
    ORDERS_DB: db,
    TURNSTILE_SECRET_KEY: 'ts-secret',
    RESEND_API_KEY: 're_test',
    SALES_NOTIFICATION_FROM: 'Amado Libros <web@notificaciones.amadolibros.com>',
    SALES_NOTIFICATION_TO: 'uno@example.com,dos@example.com',
    ...patch,
  };
}

function memoryDb({ duplicate = false } = {}) {
  const rows = new Map();
  const updates = [];
  return {
    rows,
    updates,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.includes('CREATE TABLE IF NOT EXISTS stock_waitlist')) {
                return { meta: { changes: 0 } };
              }
              if (sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_waitlist')) {
                return { meta: { changes: 0 } };
              }
              if (sql.startsWith('INSERT OR IGNORE INTO stock_waitlist')) {
                if (duplicate) return { meta: { changes: 0 } };
                const [id, productId, productTitle, email, sourceUrl, createdAt, updatedAt] = args;
                rows.set(id, {
                  id,
                  product_id: productId,
                  product_title: productTitle,
                  email,
                  source_url: sourceUrl,
                  created_at: createdAt,
                  updated_at: updatedAt,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith('UPDATE stock_waitlist SET internal_notification_status=')) {
                updates.push(args);
                return { meta: { changes: 1 } };
              }
              throw new Error(`SQL inesperado: ${sql}`);
            },
          };
        },
      };
    },
  };
}

function makeHandler({
  catalog = { items: [PAUSED, ACTIVE] },
  verify = async () => ({ ok: true }),
  fetchFn = async () => Response.json({ id: 'email-1' }),
  hooks = {},
} = {}) {
  return createStockWaitlistHandler({
    fetchCatalog: async () => {
      hooks.catalogCalls = (hooks.catalogCalls || 0) + 1;
      return catalog;
    },
    verifyTurnstileToken: async (...args) => {
      hooks.verifyArgs = args;
      return verify(...args);
    },
    fetchFn: async (...args) => {
      hooks.emailCalls = (hooks.emailCalls || 0) + 1;
      hooks.emailArgs = args;
      return fetchFn(...args);
    },
    getNow: () => NOW,
  });
}

async function call(handler, db, body, envPatch = {}, requestPatch = {}) {
  const pending = [];
  const request = new Request(
    requestPatch.url || 'https://stock-1.amadolibros-web.pages.dev/api/stock-waitlist',
    {
      method: requestPatch.method || 'POST',
      headers: {
        'Content-Type': requestPatch.contentType || 'application/json',
        ...(requestPatch.headers || {}),
      },
      body: (requestPatch.method || 'POST') === 'POST'
        ? (typeof body === 'string' ? body : JSON.stringify(body))
        : undefined,
    }
  );
  const response = await handler({
    request,
    env: env(db, envPatch),
    waitUntil(promise) { pending.push(promise); },
  });
  await Promise.all(pending);
  let data = {};
  try { data = await response.json(); } catch { /* sin body JSON */ }
  return { response, data };
}

function validBody(patch = {}) {
  return {
    product_id: 'MLU200',
    email: ' Cliente@Example.com ',
    company: '',
    source_path: '/libro/MLU200/libro-agotado',
    cf_turnstile_response: 'valid-token',
    ...patch,
  };
}

test('stock-1: registra libro no disponible, normaliza email y avisa internamente', async () => {
  const db = memoryDb();
  const hooks = {};
  const handler = makeHandler({ hooks });
  const { response, data } = await call(handler, db, validBody());

  assert.equal(response.status, 201);
  assert.equal(data.registered, true);
  assert.equal(data.already_registered, false);
  assert.equal(db.rows.size, 1);
  const row = [...db.rows.values()][0];
  assert.equal(row.product_id, 'MLU200');
  assert.equal(row.product_title, 'Libro <agotado>');
  assert.equal(row.email, 'cliente@example.com');
  assert.equal(row.source_url, 'https://stock-1.amadolibros-web.pages.dev/libro/MLU200/libro-agotado');
  assert.equal(hooks.verifyArgs[3].action, 'stock_waitlist');
  assert.equal(
    hooks.verifyArgs[3].isAllowedHostname('stock-1.amadolibros-web.pages.dev'),
    true
  );
  assert.equal(hooks.emailCalls, 1);
  const emailRequest = hooks.emailArgs[1];
  assert.equal(emailRequest.headers['Idempotency-Key'].startsWith('stock-waitlist/'), true);
  const emailBody = JSON.parse(emailRequest.body);
  assert.deepEqual(emailBody.to, ['uno@example.com', 'dos@example.com']);
  assert.match(emailBody.html, /Libro &lt;agotado&gt;/);
  assert.equal(db.updates[0][0], 'sent');
});

test('stock-1: Producción nunca intenta crear el esquema en runtime', async () => {
  const db = memoryDb();
  const originalPrepare = db.prepare;
  let ddlCalls = 0;
  db.prepare = sql => {
    if (/CREATE (TABLE|UNIQUE INDEX)/.test(sql)) ddlCalls++;
    return originalPrepare.call(db, sql);
  };
  const { response } = await call(
    makeHandler(),
    db,
    validBody(),
    {
      APP_ENV: 'production',
      ALLOWED_HOSTS: 'www.amadolibros.com',
    },
    { url: 'https://www.amadolibros.com/api/stock-waitlist' }
  );

  assert.equal(response.status, 201);
  assert.equal(ddlCalls, 0);
});

test('stock-1: el duplicado responde éxito y no vuelve a mandar correo', async () => {
  const db = memoryDb({ duplicate: true });
  const hooks = {};
  const { response, data } = await call(makeHandler({ hooks }), db, validBody());

  assert.equal(response.status, 200);
  assert.equal(data.already_registered, true);
  assert.equal(hooks.emailCalls || 0, 0);
});

test('stock-1: rechaza un libro ya disponible sin escribir D1', async () => {
  const db = memoryDb();
  const hooks = {};
  const { response, data } = await call(
    makeHandler({ hooks }),
    db,
    validBody({ product_id: 'MLU100' })
  );

  assert.equal(response.status, 409);
  assert.equal(data.code, 'ALREADY_IN_STOCK');
  assert.equal(db.rows.size, 0);
  assert.equal(hooks.emailCalls || 0, 0);
});

test('stock-1: Turnstile falla antes de consultar catálogo o D1', async () => {
  const db = memoryDb();
  const hooks = {};
  const handler = makeHandler({
    hooks,
    verify: async () => ({ ok: false, code: 'TOKEN_INVALID' }),
  });
  const { response, data } = await call(handler, db, validBody());

  assert.equal(response.status, 403);
  assert.equal(data.code, 'TOKEN_INVALID');
  assert.equal(hooks.catalogCalls || 0, 0);
  assert.equal(db.rows.size, 0);
});

test('stock-1: honeypot responde éxito sin verificar, consultar ni escribir', async () => {
  const db = memoryDb();
  const hooks = {};
  const { response } = await call(
    makeHandler({ hooks }),
    db,
    validBody({ company: 'robot inc.' })
  );

  assert.equal(response.status, 201);
  assert.equal(hooks.verifyArgs, undefined);
  assert.equal(hooks.catalogCalls || 0, 0);
  assert.equal(db.rows.size, 0);
});

test('stock-1: falta de email interno no pierde la solicitud del cliente', async () => {
  const db = memoryDb();
  const hooks = {};
  const { response } = await call(
    makeHandler({ hooks }),
    db,
    validBody(),
    { RESEND_API_KEY: '' }
  );

  assert.equal(response.status, 201);
  assert.equal(db.rows.size, 1);
  assert.equal(hooks.emailCalls || 0, 0);
  assert.equal(db.updates[0][0], 'skipped');
  assert.equal(db.updates[0][2], 'EMAIL_CONFIG_MISSING');
});

test('stock-1: el correo escapa HTML y no confía en un título del navegador', () => {
  const email = buildStockWaitlistEmail({
    product: PAUSED,
    email: 'cliente@example.com',
    sourceUrl: 'https://example.com/libro/MLU200',
  });
  assert.match(email.subject, /Libro <agotado>/);
  assert.match(email.html, /Libro &lt;agotado&gt;/);
  assert.doesNotMatch(email.html, /Libro <agotado>/);
});
