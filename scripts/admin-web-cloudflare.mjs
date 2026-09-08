export function adminCloudflare({ env = process.env, fetchFn = fetch } = {}) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!/^[a-f0-9]{32}$/.test(account || '') || !token) throw new Error('CLOUDFLARE_CONFIG_MISSING');
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  const request = async (path, { method = 'GET', body, raw = false } = {}) => {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) throw new Error('CLOUDFLARE_PATH_INVALID');
    const response = await fetchFn(`${base}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`CLOUDFLARE_HTTP_${response.status}`);
    const value = await response.json();
    if (raw && method === 'GET') return value;
    if (value.success !== true) throw new Error('CLOUDFLARE_REQUEST_FAILED');
    return value.result;
  };
  const list = async path => {
    const result = [];
    for (let page = 1; page <= 20; page++) {
      const rows = await request(`${path}?per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error('CLOUDFLARE_LIST_INVALID');
      result.push(...rows);
      if (rows.length < 100) return result;
    }
    throw new Error('CLOUDFLARE_LIST_LIMIT');
  };
  return { request, list };
}

export const ADMIN_ANALYTICS_TITLE = 'amadolibros-admin-analytics-preview';
const SHARED_KV = '6ea0ff4682d647118442a24fe384abc4';

export async function adminAnalyticsNamespace(cf, { create = false } = {}) {
  const found = (await cf.list('/storage/kv/namespaces')).filter(n => n.title === ADMIN_ANALYTICS_TITLE);
  if (found.length > 1) throw new Error('ADMIN_NAMESPACE_AMBIGUOUS');
  const ns = found[0] || (create ? await cf.request('/storage/kv/namespaces', { method: 'POST', body: { title: ADMIN_ANALYTICS_TITLE } }) : null);
  if (!ns || ns.title !== ADMIN_ANALYTICS_TITLE || !/^[a-f0-9]{32}$/.test(ns.id || '') || ns.id === SHARED_KV) throw new Error('ADMIN_NAMESPACE_INVALID');
  return ns.id;
}
