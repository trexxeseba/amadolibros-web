// Tipo de cambio del día (pesos uruguayos por unidad de cada moneda) para
// pasar el costo de las compras a pesos. Una consulta por día a una API
// pública sin clave; si falla, el panel usa el último valor guardado.
const FX_URL = 'https://open.er-api.com/v6/latest/UYU';
export const FX_CURRENCIES = ['USD', 'EUR', 'ARS', 'BRL'];

export const FX_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS fx_rates(rate_date TEXT NOT NULL,currency TEXT NOT NULL,uyu_per_unit REAL NOT NULL,fetched_at INTEGER NOT NULL,PRIMARY KEY(rate_date,currency))',
];

const montevideoDate = ms => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);

export function createFxRates({ fetcher = (...a) => globalThis.fetch(...a), now = Date.now } = {}) {
  async function sync(env) {
    const db = env?.ORDERS_DB;
    if (!db || typeof db.prepare !== 'function') return { state: 'no_storage' };
    await db.batch(FX_SCHEMA.map(sql => db.prepare(sql)));
    const date = montevideoDate(now());
    const have = await db.prepare('SELECT COUNT(*) AS n FROM fx_rates WHERE rate_date=?').bind(date).first();
    if (Number(have?.n) >= FX_CURRENCIES.length) return { state: 'fresh', date };
    const res = await fetcher(FX_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { state: 'error', error: `fx_http_${res.status}` };
    const data = await res.json().catch(() => null);
    const rates = data?.result === 'success' ? data.rates : null;
    if (!rates) return { state: 'error', error: 'fx_bad_payload' };
    const t = now();
    const stmts = [];
    for (const c of FX_CURRENCIES) {
      const perUyu = Number(rates[c]);
      if (!(perUyu > 0)) continue;
      stmts.push(db.prepare('INSERT INTO fx_rates(rate_date,currency,uyu_per_unit,fetched_at) VALUES(?,?,?,?) ON CONFLICT(rate_date,currency) DO UPDATE SET uyu_per_unit=excluded.uyu_per_unit,fetched_at=excluded.fetched_at')
        .bind(date, c, 1 / perUyu, t));
    }
    if (!stmts.length) return { state: 'error', error: 'fx_no_rates' };
    await db.batch(stmts);
    return { state: 'done', date, currencies: stmts.length };
  }
  return { sync };
}

// Último tipo de cambio guardado por moneda: { USD: 40.1, EUR: 43.5, UYU: 1, ... }.
export async function latestFx(db) {
  const out = { UYU: 1 };
  try {
    const { results } = await db.prepare(`SELECT f.currency, f.uyu_per_unit, f.rate_date FROM fx_rates f
      JOIN (SELECT currency, MAX(rate_date) AS d FROM fx_rates GROUP BY currency) m ON m.currency=f.currency AND m.d=f.rate_date`).all();
    for (const r of results) out[r.currency] = Number(r.uyu_per_unit);
    out._date = results.reduce((d, r) => (!d || r.rate_date > d ? r.rate_date : d), null);
  } catch { /* sin tabla todavía */ }
  return out;
}

export const fxRates = createFxRates();
