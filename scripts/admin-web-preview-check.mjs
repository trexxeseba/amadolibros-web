import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('worker-admin/wrangler.preview.json', 'utf8'));
const host = config.vars.ADMIN_WEB_HOST;
const team = config.vars.ADMIN_WEB_ACCESS_TEAM;
if (!/^amadolibros-admin-preview\.[a-z0-9-]+\.workers\.dev$/.test(host) ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) throw new Error('ADMIN_HOST_INVALID');
const probes = ['/admin', '/admin?view=pedidos&format=json', '/admin?view=visitas'];
let protectedCount = 0;
for (const [index, path] of probes.entries()) {
  const response = await fetch(`https://${host}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: index === 2 ? { 'Cf-Access-Jwt-Assertion': 'invalid.invalid.invalid', 'Cf-Access-Authenticated-User-Email': config.vars.ADMIN_WEB_ALLOWED_EMAILS } : {} });
  const location = response.headers.get('location');
  const login = location ? new URL(location, `https://${host}`) : null;
  if (![302, 303, 307].includes(response.status) || login?.protocol !== 'https:' || login?.hostname !== team) {
    console.error(JSON.stringify({ check: 'private_login', status: 'failed', http: response.status }));
    process.exit(1);
  }
  protectedCount++;
}
console.log(JSON.stringify({ status: 'private_login_verified', protectedChecks: protectedCount, url: `https://${host}/admin` }));
