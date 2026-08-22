import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStockWaitlistEmail,
  buildRegistrationConfirmationEmail,
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
  const confirmationUpdates = [];
  return {
    rows,
    updates,
    confirmationUpdates,
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
              if (sql.startsWith('UPDATE stock_waitlist SET registration_confirmation_status=')) {
                confirmationUpdates.push(args);
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
  pausedItem = null,
  verify = async () => ({ ok: true }),
  fetchFn = async () => Response.json({ id: 'email-1' }),
  hooks = {},
} = {}) {
  return createStockWaitlistHandler({
    fetchCatalog: async () => {
      hooks.catalogCalls = (hooks.catalogCalls || 0) + 1;
      return catalog;
    },
    fetchPausedItem: async (_context, id) => {
      hooks.pausedItemCalls = (hooks.pausedItemCalls || 0) + 1;
      return pausedItem?.id === id ? pausedItem : null;
    },
    verifyTurnstileToken: async (...args) => {
      hooks.verifyArgs = args;
      return verify(...args);
    },
    fetchFn: async (...args) => {
      hooks.emailCalls = (hooks.emailCalls || 0) + 1;
      hooks.emailArgs = args;
      hooks.emailCallArgs = (hooks.emailCallArgs || []).concat([args]);
      return fetchFn(...args);
    },
    getNow: () => NOW,
    sleep: async () => {},
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

test('stock-1: valida un pausado desde su bloque cuando no está en catalog.json', async () => {
  const db = memoryDb();
  const hooks = {};
  const handler = makeHandler({
    catalog: { items: [ACTIVE] },
    pausedItem: PAUSED,
    hooks,
  });
  const { response, data } = await call(handler, db, validBody());

  assert.equal(response.status, 201);
  assert.equal(data.registered, true);
  assert.equal(hooks.pausedItemCalls, 1);
  assert.equal([...db.rows.values()][0].product_id, PAUSED.id);
});

test('CF-STOCK-1-UX-FIX: en producción también valida un pausado desde su bloque cuando no está en catalog.json', async () => {
  // Regresión: el fallback a fetchPausedItem estaba hardcodeado a
  // APP_ENV==='preview' y nunca se actualizó cuando CF-R2-2-BRIDGE
  // generalizó el resto del catálogo pausado a producción. Un libro
  // genuinamente pausado devolvía 404 "Libro no encontrado" en
  // producción antes de llegar a D1 — confirmado con 0 filas reales en
  // producción tras dos envíos humanos.
  const db = memoryDb();
  const hooks = {};
  const handler = makeHandler({
    catalog: { items: [ACTIVE] },
    pausedItem: PAUSED,
    hooks,
  });
  const { response, data } = await call(
    handler,
    db,
    validBody(),
    { APP_ENV: 'production', ALLOWED_HOSTS: 'www.amadolibros.com' },
    { url: 'https://www.amadolibros.com/api/stock-waitlist' },
  );

  assert.equal(response.status, 201);
  assert.equal(data.registered, true);
  assert.equal(hooks.pausedItemCalls, 1);
  assert.equal([...db.rows.values()][0].product_id, PAUSED.id);
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

// ── STOCK-AVISO-2: confirmación al cliente ──────────────────────────────────

function prodEnvPatch(patch = {}) {
  return {
    APP_ENV: 'production',
    ALLOWED_HOSTS: 'www.amadolibros.com',
    CANONICAL_ORIGIN: 'https://www.amadolibros.com',
    ...patch,
  };
}
const PROD_REQUEST = { url: 'https://www.amadolibros.com/api/stock-waitlist' };

test('STOCK-AVISO-2: un registro nuevo en producción envía la confirmación al cliente exactamente una vez', async () => {
  const db = memoryDb();
  const hooks = {};
  const { response, data } = await call(
    makeHandler({ hooks }),
    db,
    validBody(),
    prodEnvPatch(),
    PROD_REQUEST
  );

  assert.equal(response.status, 201);
  assert.equal(data.already_registered, false);
  assert.equal(hooks.emailCalls, 2, 'aviso interno + confirmación al cliente');
  const confirmationCall = hooks.emailCallArgs.find(
    args => args[1].headers['Idempotency-Key'].startsWith('stock-waitlist-confirm/')
  );
  assert.ok(confirmationCall, 'debe haber una llamada con el idempotency key de confirmación');
  const confirmationBody = JSON.parse(confirmationCall[1].body);
  assert.deepEqual(confirmationBody.to, ['cliente@example.com']);
  assert.match(confirmationBody.subject, /Te avisaremos cuando vuelva/);
  assert.match(confirmationBody.html, />Ver libro</);
  assert.equal(db.confirmationUpdates.length, 1);
  assert.equal(db.confirmationUpdates[0][0], 'sent');
});

test('STOCK-AVISO-2: en Preview no se envía confirmación real al cliente (CANONICAL_ORIGIN no productivo)', async () => {
  const db = memoryDb();
  const hooks = {};
  const { response } = await call(handlerDefault(hooks), db, validBody());

  assert.equal(response.status, 201);
  // Solo el aviso interno debe llamar a Resend; la confirmación se salta.
  assert.equal(hooks.emailCalls, 1);
  assert.equal(db.confirmationUpdates.length, 1);
  assert.equal(db.confirmationUpdates[0][0], 'skipped');
});

function handlerDefault(hooks) {
  return makeHandler({ hooks });
}

test('STOCK-AVISO-2: el duplicado no repite la confirmación al cliente', async () => {
  const db = memoryDb({ duplicate: true });
  const hooks = {};
  const { response, data } = await call(
    makeHandler({ hooks }),
    db,
    validBody(),
    prodEnvPatch(),
    PROD_REQUEST
  );

  assert.equal(response.status, 200);
  assert.equal(data.already_registered, true);
  assert.equal(hooks.emailCalls || 0, 0);
  assert.equal(db.confirmationUpdates.length, 0);
});

test('STOCK-AVISO-2: honeypot no dispara ninguna confirmación', async () => {
  const db = memoryDb();
  const hooks = {};
  const { response } = await call(
    makeHandler({ hooks }),
    db,
    validBody({ company: 'robot inc.' }),
    prodEnvPatch(),
    PROD_REQUEST
  );

  assert.equal(response.status, 201);
  assert.equal(hooks.emailCalls || 0, 0);
  assert.equal(db.confirmationUpdates.length, 0);
});

test('STOCK-AVISO-2: Turnstile inválido no dispara ninguna confirmación', async () => {
  const db = memoryDb();
  const hooks = {};
  const handler = makeHandler({ hooks, verify: async () => ({ ok: false, code: 'TOKEN_INVALID' }) });
  const { response } = await call(handler, db, validBody(), prodEnvPatch(), PROD_REQUEST);

  assert.equal(response.status, 403);
  assert.equal(hooks.emailCalls || 0, 0);
  assert.equal(db.confirmationUpdates.length, 0);
});

test('STOCK-AVISO-2: libro ya disponible no registra ni confirma', async () => {
  const db = memoryDb();
  const hooks = {};
  const { response } = await call(
    makeHandler({ hooks }),
    db,
    validBody({ product_id: 'MLU100' }),
    prodEnvPatch(),
    PROD_REQUEST
  );

  assert.equal(response.status, 409);
  assert.equal(db.rows.size, 0);
  assert.equal(hooks.emailCalls || 0, 0);
  assert.equal(db.confirmationUpdates.length, 0);
});

test('STOCK-AVISO-2: una falla persistente de Resend en la confirmación no pierde el registro y reintenta', async () => {
  const db = memoryDb();
  const hooks = {};
  let confirmationCalls = 0;
  const handler = makeHandler({
    hooks,
    fetchFn: async (_url, init) => {
      const isConfirmation = init.headers['Idempotency-Key'].startsWith('stock-waitlist-confirm/');
      if (isConfirmation) {
        confirmationCalls++;
        return new Response('{}', { status: 503 });
      }
      return Response.json({ id: 'email-internal' });
    },
  });
  const { response, data } = await call(handler, db, validBody(), prodEnvPatch(), PROD_REQUEST);

  assert.equal(response.status, 201);
  assert.equal(data.registered, true);
  assert.equal(db.rows.size, 1, 'el registro en D1 se conserva pese a la falla de email');
  assert.equal(confirmationCalls, 3, 'una falla 503 se reintenta hasta el máximo configurado');
  assert.equal(db.confirmationUpdates[0][0], 'failed');
  assert.equal(db.confirmationUpdates[0][2], 'RESEND_HTTP_503');
});

test('STOCK-AVISO-2: una URL fuera de amadolibros.com nunca se usa para confirmar', async () => {
  const db = memoryDb();
  const hooks = {};
  const handler = makeHandler({ hooks });
  const { response } = await call(
    handler,
    db,
    validBody(),
    prodEnvPatch(),
    { url: 'https://evil.example.com/api/stock-waitlist' }
  );

  assert.equal(response.status, 201);
  assert.equal(db.confirmationUpdates.length, 1);
  assert.equal(db.confirmationUpdates[0][0], 'skipped');
  // Solo el aviso interno debió llamar a Resend.
  assert.equal(hooks.emailCalls, 1);
});

test('STOCK-AVISO-2: la confirmación escapa HTML y no confía en un título del navegador', () => {
  const email = buildRegistrationConfirmationEmail({
    product: PAUSED,
    url: 'https://www.amadolibros.com/libro/MLU200',
  });
  assert.match(email.subject, /Te avisaremos cuando vuelva «Libro <agotado>»/);
  assert.match(email.html, /Libro &lt;agotado&gt;/);
  assert.doesNotMatch(email.html, /Libro <agotado>/);
  assert.match(email.html, /No es una reserva ni garantiza disponibilidad/);
});
