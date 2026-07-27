// Verifica que wrangler.toml, deploy.yml y carrito.astro sigan declarando la
// configuración de Producción esperada tras 2-N-H1: MP_COLLECTOR_ID
// confirmado, checkout ENCENDIDO en ambos niveles (runtime y build), la site
// key pública de Turnstile de Producción inyectada por build en vez de
// hardcodeada en el código, y el smoke post-deploy declarando explícitamente
// qué estado de checkout espera encontrar.
//
// Los dos interruptores deben moverse juntos: si un rollback baja uno solo,
// estos tests fallan y avisan de la inconsistencia.
//
// No hay tests sobre deploy-preview.yml acá a propósito: ese workflow no es
// actualmente el pipeline efectivo para ningún Preview con checkout (su
// trigger sigue limitado a la rama `astro-migration`, sin código de pagos),
// y 2-N-G2 no lo modificó — ver docs/environments.md, sección "Pendientes".
// Afirmar mediante un test que "la site key de Producción no se usa en el
// build de Preview" no es verificable mientras ese pipeline no exista.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const wranglerToml = readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
const deployYml = readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
const carritoAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'pages', 'carrito.astro'),
  'utf8',
);

const PRODUCTION_SITE_KEY = '0x4AAAAAAD_Ul8KGae_hdWwj';
const PREVIEW_SITE_KEY = '0x4AAAAAAD6E9kz8K3comwjj';

function extractTomlSection(toml, header) {
  const start = toml.indexOf(header);
  assert.notEqual(start, -1, `sección ${header} no encontrada en wrangler.toml`);
  const rest = toml.slice(start + header.length);
  const nextHeaderIdx = rest.search(/\n\s*\[/);
  return nextHeaderIdx === -1 ? rest : rest.slice(0, nextHeaderIdx);
}

const productionVars = extractTomlSection(wranglerToml, '[env.production.vars]');

test('wrangler.toml: Producción resuelve MP_COLLECTOR_ID=440298103', () => {
  assert.match(productionVars, /MP_COLLECTOR_ID\s*=\s*"440298103"/);
});

test('wrangler.toml: CHECKOUT_ENABLED de Producción está en true (2-N-H1)', () => {
  assert.match(productionVars, /CHECKOUT_ENABLED\s*=\s*"true"/);
});

test('wrangler.toml: Producción conserva APP_ENV, CANONICAL_ORIGIN y ALLOWED_HOSTS intactos', () => {
  assert.match(productionVars, /APP_ENV\s*=\s*"production"/);
  assert.match(productionVars, /CANONICAL_ORIGIN\s*=\s*"https:\/\/www\.amadolibros\.com"/);
  assert.match(productionVars, /ALLOWED_HOSTS\s*=\s*"amadolibros\.com,www\.amadolibros\.com"/);
});

test('wrangler.toml: Producción no declara secrets (MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET, TURNSTILE_SECRET_KEY)', () => {
  assert.doesNotMatch(productionVars, /MP_ACCESS_TOKEN/);
  assert.doesNotMatch(productionVars, /MP_WEBHOOK_SECRET/);
  assert.doesNotMatch(productionVars, /TURNSTILE_SECRET_KEY/);
});

test('deploy.yml: build de Producción tiene PUBLIC_CHECKOUT_ENABLED en true (2-N-H1)', () => {
  assert.match(deployYml, /PUBLIC_CHECKOUT_ENABLED:\s*'true'/);
  assert.doesNotMatch(deployYml, /PUBLIC_CHECKOUT_ENABLED:\s*'false'/);
});

test('deploy.yml: el smoke post-deploy declara SMOKE_EXPECT_CHECKOUT=enabled', () => {
  assert.match(deployYml, /SMOKE_EXPECT_CHECKOUT:\s*'enabled'/);
});

test('deploy.yml: los dos interruptores de checkout coinciden entre sí', () => {
  // Un rollback a medias (frontend apagado pero smoke esperando "enabled", o
  // viceversa) haría que el deploy pase el smoke mostrando el estado
  // equivocado. Los dos valores tienen que moverse juntos.
  const publicFlag = deployYml.match(/PUBLIC_CHECKOUT_ENABLED:\s*'(true|false)'/);
  const smokeFlag  = deployYml.match(/SMOKE_EXPECT_CHECKOUT:\s*'(enabled|disabled)'/);
  assert.ok(publicFlag, 'PUBLIC_CHECKOUT_ENABLED no encontrado en deploy.yml');
  assert.ok(smokeFlag, 'SMOKE_EXPECT_CHECKOUT no encontrado en deploy.yml');
  const expectedSmoke = publicFlag[1] === 'true' ? 'enabled' : 'disabled';
  assert.equal(smokeFlag[1], expectedSmoke);
});

test('deploy.yml: contiene solamente la site key pública de Turnstile de Producción', () => {
  assert.match(deployYml, new RegExp(`PUBLIC_TURNSTILE_SITE_KEY:\\s*'${PRODUCTION_SITE_KEY}'`));
  assert.doesNotMatch(deployYml, new RegExp(PREVIEW_SITE_KEY));
});

test('deploy.yml: restringe Turnstile a los hosts de Producción', () => {
  assert.match(
    deployYml,
    /PUBLIC_TURNSTILE_ALLOWED_HOSTS:\s*'amadolibros\.com,www\.amadolibros\.com'/,
  );
});

test('carrito.astro: no contiene ninguna site key de Turnstile hardcodeada', () => {
  assert.doesNotMatch(carritoAstro, new RegExp(PRODUCTION_SITE_KEY));
  assert.doesNotMatch(carritoAstro, new RegExp(PREVIEW_SITE_KEY));
});

test('carrito.astro: la site key se lee de PUBLIC_TURNSTILE_SITE_KEY, no de un literal', () => {
  assert.match(carritoAstro, /import\.meta\.env\.PUBLIC_TURNSTILE_SITE_KEY/);
});
