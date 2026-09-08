import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkAdminPreview({ config, fetchFn = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const host = config.vars.ADMIN_WEB_HOST;
  const team = config.vars.ADMIN_WEB_ACCESS_TEAM;
  if (!/^amadolibros-admin-preview\.[a-z0-9-]+\.workers\.dev$/.test(host) ||
      !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) throw new Error('ADMIN_HOST_INVALID');
  const probes = ['/admin', '/admin?view=pedidos&format=json', '/admin?view=visitas'];
  let protectedCount = 0;
  for (const [index, path] of probes.entries()) {
    let response;
    for (let attempt = 0; attempt < 7; attempt++) {
      if (attempt) await pause(5000);
      response = await fetchFn(`https://${host}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(20000),
        headers: index === 2 ? { 'Cf-Access-Jwt-Assertion': 'invalid.invalid.invalid', 'Cf-Access-Authenticated-User-Email': config.vars.ADMIN_WEB_ALLOWED_EMAILS } : {} });
      // El hostname nuevo puede devolver 404 mientras se propaga. Una respuesta
      // 200 o un redirect ajeno nunca se tolera ni se interpreta como protección.
      if (response.status !== 404) break;
    }
    const location = response.headers.get('location');
    const login = location ? new URL(location, `https://${host}`) : null;
    if (![302, 303, 307].includes(response.status) || login?.protocol !== 'https:' || login?.hostname !== team) {
      throw new Error(`ADMIN_PRIVATE_LOGIN_HTTP_${response.status}`);
    }
    protectedCount++;
  }
  return { status: 'private_login_verified', protectedChecks: protectedCount, url: `https://${host}/admin` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = JSON.parse(await readFile('worker-admin/wrangler.preview.json', 'utf8'));
    console.log(JSON.stringify(await checkAdminPreview({ config })));
  } catch (error) {
    console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'ADMIN_PRIVATE_LOGIN_FAILED');
    process.exitCode = 1;
  }
}
