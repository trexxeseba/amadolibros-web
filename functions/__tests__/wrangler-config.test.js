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
// Desde 2-O-R1 también verifica la barrera de validación compartida entre
// ci.yml y deploy.yml (scripts/validate-ci.sh): que el job `deploy` no pueda
// arrancar sin `needs: validate`, y que ninguno de los dos workflows vuelva a
// hardcodear la site key de Turnstile por su cuenta — scripts/validate-ci.sh
// es la única fuente de verdad de ese valor.
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

const wranglerToml   = readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
const deployYml      = readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
const ciYml          = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const validateCiSh   = readFileSync(path.join(ROOT, 'scripts', 'validate-ci.sh'), 'utf8');
const carritoAstro = readFileSync(
  path.join(ROOT, 'astro-front', 'src', 'pages', 'carrito.astro'),
  'utf8',
);

const PRODUCTION_SITE_KEY = '0x4AAAAAAD_Ul8KGae_hdWwj';
const PREVIEW_SITE_KEY = '0x4AAAAAAD6E9kz8K3comwjj';
const VALIDATE_SCRIPT_INVOCATION = /bash\s+scripts\/validate-ci\.sh\b/;

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

test('wrangler.toml: Producción declara remitente y destinatarios de email', () => {
  assert.match(
    productionVars,
    /SALES_NOTIFICATION_FROM\s*=\s*"Amado Libros <web@notificaciones\.amadolibros\.com>"/,
  );
  assert.match(
    productionVars,
    /SALES_NOTIFICATION_TO\s*=\s*"undiaes@gmail\.com,adm@amadolibros\.com"/,
  );
});

test('wrangler.toml: Producción no declara secrets', () => {
  assert.doesNotMatch(productionVars, /MP_ACCESS_TOKEN/);
  assert.doesNotMatch(productionVars, /MP_WEBHOOK_SECRET/);
  assert.doesNotMatch(productionVars, /TURNSTILE_SECRET_KEY/);
  assert.doesNotMatch(productionVars, /RESEND_API_KEY/);
});

test('deploy.yml: sincroniza RESEND_API_KEY cifrada antes de publicar', () => {
  const secretStepIdx = deployYml.indexOf('Sync Resend secret to Cloudflare Pages');
  const deployStepIdx = deployYml.indexOf('Deploy via Wrangler');
  assert.notEqual(secretStepIdx, -1, 'step de sincronización de Resend no encontrado');
  assert.notEqual(deployStepIdx, -1, 'step de deploy no encontrado');
  assert.ok(secretStepIdx < deployStepIdx, 'el secret debe sincronizarse antes del deploy');
  assert.match(deployYml, /RESEND_API_KEY:\s*\$\{\{\s*secrets\.RESEND_API_KEY\s*\}\}/);
  assert.match(
    deployYml,
    /wrangler@3\.114\.17 pages secret put RESEND_API_KEY --project-name amadolibros-web/,
  );
  assert.match(deployYml, /if \[ -z "\$RESEND_API_KEY" \]/);
  assert.doesNotMatch(deployYml, /re_[A-Za-z0-9_-]+/);
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

test('deploy.yml: no hardcodea la site key de Turnstile — la toma del script compartido', () => {
  // Desde 2-O-R1 el build real del deploy carga estos dos valores del
  // step "Load production Turnstile config" (steps.ts_config.outputs), que
  // a su vez corre `scripts/validate-ci.sh --print-turnstile-config` — nunca
  // un literal aparte en este YAML que pudiera desviarse del que el job
  // `validate` ya probó.
  assert.match(deployYml, /PUBLIC_TURNSTILE_SITE_KEY:\s*\$\{\{\s*steps\.ts_config\.outputs\.site_key\s*\}\}/);
  assert.match(deployYml, /PUBLIC_TURNSTILE_ALLOWED_HOSTS:\s*\$\{\{\s*steps\.ts_config\.outputs\.allowed_hosts\s*\}\}/);
  assert.doesNotMatch(deployYml, new RegExp(`PUBLIC_TURNSTILE_SITE_KEY:\\s*'${PRODUCTION_SITE_KEY}'`));
  assert.doesNotMatch(deployYml, new RegExp(PREVIEW_SITE_KEY));
});

test('deploy.yml: carga la config de Turnstile ejecutando el script compartido con --print-turnstile-config', () => {
  assert.match(deployYml, /scripts\/validate-ci\.sh\s+--print-turnstile-config/);
});

test('scripts/validate-ci.sh: única fuente de verdad de la site key de Producción y sus hosts', () => {
  assert.match(validateCiSh, new RegExp(`PRODUCTION_TURNSTILE_SITE_KEY='${PRODUCTION_SITE_KEY}'`));
  assert.match(validateCiSh, /PRODUCTION_TURNSTILE_ALLOWED_HOSTS='amadolibros\.com,www\.amadolibros\.com'/);
  assert.match(validateCiSh, new RegExp(`PREVIEW_TURNSTILE_SITE_KEY='${PREVIEW_SITE_KEY}'`));
});

test('scripts/validate-ci.sh: --print-turnstile-config no ejecuta tests ni builds (solo imprime)', () => {
  assert.match(validateCiSh, /--print-turnstile-config/);
  // El bloque del flag debe salir (exit 0) antes de llegar a los pasos de
  // sintaxis/tests/build — si alguien borra ese `exit 0`, --print-turnstile-config
  // dejaría de ser liviano y correría toda la validación solo para leer dos
  // strings, además de dejar un directorio dist/ a medio construir en un step
  // que solo debería poblar variables de entorno.
  const flagIdx = validateCiSh.indexOf('--print-turnstile-config"');
  const exitIdx = validateCiSh.indexOf('exit 0', flagIdx);
  const syntaxStepIdx = validateCiSh.indexOf('Sintaxis JS');
  assert.ok(flagIdx !== -1 && exitIdx !== -1 && syntaxStepIdx !== -1);
  assert.ok(exitIdx < syntaxStepIdx, 'el flag debe salir antes del paso de sintaxis/tests/builds');
});

// ── Barrera de validación antes del deploy (2-O-R1) ─────────────────────────

test('deploy.yml: el job "deploy" no puede arrancar sin needs: validate', () => {
  const deployJobIdx = deployYml.indexOf('\n  deploy:');
  assert.notEqual(deployJobIdx, -1, 'job "deploy" no encontrado en deploy.yml');
  const deployJobBlock = deployYml.slice(deployJobIdx, deployJobIdx + 200);
  assert.match(deployJobBlock, /needs:\s*validate/);
});

test('deploy.yml: existe un job "validate" que corre el script compartido', () => {
  const validateJobIdx = deployYml.indexOf('\n  validate:');
  assert.notEqual(validateJobIdx, -1, 'job "validate" no encontrado en deploy.yml');
  const validateJobBlock = deployYml.slice(validateJobIdx, deployYml.indexOf('\n  deploy:'));
  assert.match(validateJobBlock, VALIDATE_SCRIPT_INVOCATION);
});

test('ci.yml y deploy.yml invocan exactamente el mismo script de validación', () => {
  assert.match(ciYml, VALIDATE_SCRIPT_INVOCATION);
  assert.match(deployYml, VALIDATE_SCRIPT_INVOCATION);
  // Ninguno de los dos debe seguir teniendo su propia copia de los pasos de
  // sintaxis/tests — eso es exactamente lo que se dejó de duplicar.
  assert.doesNotMatch(ciYml, /node --check/);
  assert.doesNotMatch(deployYml, /node --check/);
});

test('carrito.astro: no contiene ninguna site key de Turnstile hardcodeada', () => {
  assert.doesNotMatch(carritoAstro, new RegExp(PRODUCTION_SITE_KEY));
  assert.doesNotMatch(carritoAstro, new RegExp(PREVIEW_SITE_KEY));
});

test('carrito.astro: la site key se lee de PUBLIC_TURNSTILE_SITE_KEY, no de un literal', () => {
  assert.match(carritoAstro, /import\.meta\.env\.PUBLIC_TURNSTILE_SITE_KEY/);
});
