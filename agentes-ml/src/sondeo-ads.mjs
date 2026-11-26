// Sondeo de SOLO LECTURA (26/11/2026): por qué Mercado Ads responde 401 al pausar por API.
// Imprime códigos HTTP, claves y permisos/scopes (nombres), nunca montos ni datos de terceros.
import { CUENTA } from './config.mjs';
import { crearCliente } from './ml.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';

const ml = crearCliente(fuenteTokenD1(CUENTA), { intentos: 2, concurrencia: 1 });
const yo = await ml.get('/users/me');
if (String(yo?.id) !== CUENTA.sellerId) throw new Error('token_de_otra_cuenta');
const S = CUENTA.sellerId, APP = '4741021817925208', H = { headers: { 'Api-Version': '2' } };
const out = {};
const ver = async (nombre, ruta, o) => { const r = await ml.sonda(ruta, o); const j = r.json; out[nombre] = { status: r.status, claves: j && typeof j === 'object' ? Object.keys(Array.isArray(j) ? (j[0] ?? {}) : j).slice(0, 30) : null, scopes: JSON.stringify(j ?? {}).match(/urn:ml:[a-z:\/_-]+|"(read|write|offline_access|read-write)"/g)?.slice(0, 40) ?? null, roles: JSON.stringify(j ?? {}).match(/"(role|roles|permissions|user_type|status)":("[^"]*"|\[[^\]]*\])/g)?.slice(0, 20) ?? null, mensaje: j?.message ?? j?.error ?? null }; };
await ver('applications_app', `/applications/${APP}`);
await ver('users_applications', `/users/${S}/applications`);
await ver('users_applications_app', `/users/${S}/applications/${APP}`);
await ver('advertisers_pads', `/advertising/advertisers?product_id=PADS`, H);
await ver('advertiser_51659', `/advertising/MLU/advertisers/51659`, H);
await ver('ads_campaigns', `/advertising/MLU/advertisers/51659/product_ads/campaigns/search?limit=1`, H);
console.log(JSON.stringify(out, null, 1));
