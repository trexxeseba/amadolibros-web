// BLOQUEANTE reproducido en la Preview checkout-ON (checkout-v11-preview):
// con datos válidos y Mercado Pago elegido, POST /api/orders fallaba con
// "Error: Error al guardar el pedido. Intentá de nuevo." — el batch de
// INSERT en `orders` referencia buyer_email (migración 0006) y
// ga_client_id/ga_session_id (migración 0008), pero ningún workflow aplica
// migraciones a la D1 de Preview (sólo deploy.yml, y sólo --env production)
// — la D1 de Preview (amadolibros-orders-preview) nunca las tenía.
//
// Cubre: (1) el nuevo paso que aplica migraciones a la D1 de Preview en el
// workflow dedicado; (2) que el frontend ya no antepone "Error: " al
// mensaje del servidor (que generaba el "Error: Error..." duplicado
// reportado). La causa raíz del guardado en sí (mensaje/code/logging del
// backend) está cubierta en functions/api/__tests__/orders.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = readFileSync(
  path.join(ROOT, '.github', 'workflows', 'deploy-checkout-v11-preview.yml'),
  'utf8',
);
const CARRITO = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'pages', 'carrito.astro'),
  'utf8',
);

test('deploy-checkout-v11-preview.yml aplica migraciones a la D1 de Preview antes de desplegar', () => {
  assert.match(WORKFLOW, /d1 migrations apply\s*\n?\s*ORDERS_DB --env preview --remote/);
  // Debe ejecutarse antes del deploy/smoke, no después — si no, el primer
  // pedido de prueba contra un deploy recién hecho podría volver a fallar.
  const migrateIdx = WORKFLOW.indexOf('d1 migrations apply');
  const deployIdx = WORKFLOW.indexOf('pages deploy ./astro-front/dist');
  const smokeIdx = WORKFLOW.indexOf('Smoke — el checkout online');
  assert.ok(migrateIdx !== -1 && migrateIdx < deployIdx && deployIdx < smokeIdx);
});

test('el handler de Mercado Pago ya no antepone "Error: " al mensaje del servidor (evita el "Error: Error..." duplicado)', () => {
  const start = CARRITO.indexOf("btnPrepare.addEventListener('click'");
  assert.notEqual(start, -1);
  const block = CARRITO.slice(start, start + 8000);
  assert.doesNotMatch(block, /showCheckoutError\('Error: '/);
  assert.match(block, /showCheckoutError\(orderData\.error \|\|/);
});
