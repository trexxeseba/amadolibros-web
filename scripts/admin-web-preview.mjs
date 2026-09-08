import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adminCloudflare, adminAnalyticsNamespace } from './admin-web-cloudflare.mjs';

export const ADMIN_WORKER = 'amadolibros-admin-preview';
export const ADMIN_ACCESS_NAME = 'Amado web admin - private preview';
const ID = /^[a-zA-Z0-9-]{1,80}$/;

export function validateAdminPolicy(policies, ownerEmail) {
  if (!Array.isArray(policies) || policies.length !== 1) return false;
  const p = policies[0];
  return p.decision === 'allow' && p.include?.length === 1 &&
    Object.keys(p.include[0]).length === 1 && p.include[0].email?.email?.toLowerCase() === ownerEmail &&
    !(p.exclude?.length) && !(p.require?.length);
}

export async function prepareAdminPreview({ cf, ownerEmail }) {
  ownerEmail = String(ownerEmail || '').trim().toLowerCase();
  if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(ownerEmail)) throw new Error('ADMIN_OWNER_REQUIRED');
  const [org, subdomain, namespaceId, apps, idps] = await Promise.all([
    cf.request('/access/organizations'), cf.request('/workers/subdomain'),
    adminAnalyticsNamespace(cf), cf.list('/access/apps'), cf.request('/access/identity_providers'),
  ]);
  if (!/^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/.test(org?.auth_domain || '') ||
      !/^[a-z0-9][a-z0-9-]*$/.test(subdomain?.subdomain || '')) throw new Error('ADMIN_ACCESS_CONFIG_INVALID');
  const hostname = `${ADMIN_WORKER}.${subdomain.subdomain}.workers.dev`;
  const matches = apps.filter(app => app.name === ADMIN_ACCESS_NAME || app.domain === hostname);
  if (matches.length > 1) throw new Error('ADMIN_ACCESS_AMBIGUOUS');
  const identity = Array.isArray(idps) && (idps.find(p => p.type === 'onetimepin') || idps.find(p => p.type === 'google'));
  if (!identity || !ID.test(identity.id)) throw new Error('ADMIN_IDENTITY_PROVIDER_REQUIRED');
  let app = matches[0];
  if (!app) app = await cf.request('/access/apps', { method: 'POST', body: {
    type: 'self_hosted', name: ADMIN_ACCESS_NAME, domain: hostname, session_duration: '8h',
    app_launcher_visible: false, allowed_idps: [identity.id],
    policies: [{ name: 'Titular Amado Libros', decision: 'allow', include: [{ email: { email: ownerEmail } }] }],
  } });
  if (!app || !ID.test(app.id || '') || app.name !== ADMIN_ACCESS_NAME || app.domain !== hostname ||
      app.type !== 'self_hosted' || !/^[a-f0-9]{32,128}$/.test(app.aud || '')) throw new Error('ADMIN_ACCESS_APP_INVALID');
  const policies = await cf.request(`/access/apps/${app.id}/policies`);
  if (!validateAdminPolicy(policies, ownerEmail)) throw new Error('ADMIN_ACCESS_POLICY_INVALID');
  // El Worker es nuevo y separado; la tienda y sus bindings no se modifican.
  // Los pedidos de Producción se consultan con los SELECT acotados ya probados.
  const config = { name: ADMIN_WORKER, main: 'index.js', compatibility_date: '2024-09-23',
    workers_dev: true, preview_urls: false, observability: { enabled: false },
    vars: { APP_ENV: 'preview', ADMIN_WEB_DATA_ENV: 'production', ADMIN_WEB_ENABLED: 'true',
      ADMIN_WEB_HOST: hostname, ADMIN_WEB_ACCESS_TEAM: org.auth_domain, ADMIN_WEB_ACCESS_AUD: app.aud,
      ADMIN_WEB_ALLOWED_EMAILS: ownerEmail },
    kv_namespaces: [{ binding: 'ADMIN_WEB_ANALYTICS_KV', id: namespaceId }],
    d1_databases: [{ binding: 'ORDERS_DB', database_name: 'amadolibros-orders-production', database_id: '6dc8dc3a-2d4f-4045-b428-14323c7b0bcd' }],
  };
  return { config, url: `https://${hostname}/admin`, login: identity.type };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await prepareAdminPreview({ cf: adminCloudflare(), ownerEmail: process.env.ADMIN_WEB_OWNER_EMAIL });
    await mkdir('worker-admin', { recursive: true });
    await writeFile('worker-admin/wrangler.preview.json', JSON.stringify(result.config, null, 2), { mode: 0o600 });
    // Sólo metadatos de la entrega; nunca los informes ni configuración de acceso.
    console.log(JSON.stringify({ status: 'configured', url: result.url, login: result.login }));
  } catch (error) {
    console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'ADMIN_PREVIEW_FAILED');
    process.exitCode = 1;
  }
}
