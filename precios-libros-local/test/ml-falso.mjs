// Mercado Libre falso para tests: rutas mínimas, registra cada llamada.
export function mlFalso({ items, ofertas = {}, promos = {}, auto = {}, ptw = {}, putFalla = null }) {
  const llamadas = [];
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
  const fetcher = async (url, o = {}) => {
    const u = new URL(url), p = u.pathname, m = o.method ?? 'GET';
    llamadas.push(`${m} ${p}${u.search}`);
    if (p === '/users/me') return json({ id: 440298103, site_id: 'MLU' });
    if (p.startsWith('/users/440298103/items/search')) return json({ results: Object.keys(items), scroll_id: null });
    if (p === '/items/bulk') return json(u.searchParams.get('ids').split(',').map(id => ({ status_code: 200, body: items[id] })));
    let mm;
    if ((mm = p.match(/^\/items\/(MLU\d+)$/))) {
      if (m === 'PUT') {
        if (putFalla) { const r = putFalla(mm[1], JSON.parse(o.body)); if (r) return r; }
        items[mm[1]].price = JSON.parse(o.body).price; return json(items[mm[1]]);
      }
      return items[mm[1]] ? json(items[mm[1]]) : json({}, 404);
    }
    if ((mm = p.match(/^\/items\/(MLU\d+)\/sale_price$/))) return json({ amount: items[mm[1]].price, regular_amount: items[mm[1]].price, currency_id: 'UYU' });
    if ((mm = p.match(/^\/items\/(MLU\d+)\/prices$/))) return json({ prices: [{ type: 'standard', amount: items[mm[1]].price }] });
    if ((mm = p.match(/^\/items\/(MLU\d+)\/price_to_win$/))) return ptw[mm[1]] ? json(ptw[mm[1]]) : json({ status: 'not_listed', reason: ['item_not_opted_in'] });
    if ((mm = p.match(/^\/seller-promotions\/items\/(MLU\d+)$/))) return json(promos[mm[1]] ?? []);
    if ((mm = p.match(/^\/pricing-automation\/items\/(MLU\d+)\/automation$/))) return auto[mm[1]] ? json(auto[mm[1]]) : json({ message: 'not found' }, 404);
    if ((mm = p.match(/^\/products\/([A-Z0-9]+)\/items$/))) { const r = ofertas[mm[1]] ?? []; return json({ results: r, paging: { total: r.length } }); }
    if ((mm = p.match(/^\/products\/([A-Z0-9]+)$/))) return json({ attributes: [] });
    return json({ message: 'no route ' + p }, 404);
  };
  return { fetcher, llamadas };
}
export const it = (id, price, o = {}) => ({ id, title: 'Libro ' + id, seller_id: 440298103, site_id: 'MLU', price, currency_id: 'UYU', status: 'active', catalog_listing: true, catalog_product_id: 'MLU' + id.slice(3) + '0', condition: 'new', variations: [], tags: [], attributes: [], ...o });
