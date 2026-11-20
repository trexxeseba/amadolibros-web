// Temporal (solo lectura): ver si desde GitHub se puede leer la tienda GLIC (sin token y con token).
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {CUENTA_HERMES} from './lib.mjs';
const fuente = fuenteTokenD1(CUENTAS[CUENTA_HERMES]);
const tok = await fuente.getToken();
const urls = [
  'https://api.mercadolibre.com/sites/MLU/search?nickname=GLIC&limit=5',
  'https://api.mercadolibre.com/sites/MLU/search?q=libro&limit=2',
  'https://api.mercadolibre.com/users/search?nickname=GLIC',
  'https://listado.mercadolibre.com.uy/tienda/glic/listado/libros-revistas-comics/',
  'https://www.mercadolibre.com.uy/tienda/glic',
  'https://api.mercadolibre.com/products/search?site_id=MLU&status=active&product_identifier=9780735211292',
];
for (const u of urls) for (const conToken of [false, true]) {
  try {
    const r = await fetch(u, {redirect: 'manual', headers: {'User-Agent': 'Mozilla/5.0', ...(conToken ? {Authorization: 'Bearer ' + tok} : {})}});
    const t = (await r.text()).slice(0, 160).replace(/\s+/g, ' ');
    console.log('PRUEBA', conToken ? 'token' : 'sin-token', r.status, u.slice(0, 90), '|', t);
  } catch (e) { console.log('PRUEBA', u.slice(0, 90), 'error', e.message); }
}
