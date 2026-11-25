// Sonda: ¿Mercado Ads acepta cambiar el estado de un anuncio por API?
//
//   node poda/src/sonda-escritura.mjs
//
// NO cambia nada. Toma anuncios (ad groups) que la API ya informa PAUSED y les manda
// "pausar" por cada ruta candidata. Un anuncio pausado al que se le pide pausar queda
// igual. Nunca se envía "active". Antes y después de cada intento relee el estado:
// si alguno dejara de estar PAUSED, frena en el acto y lo informa.
//
// Interpretación de cada respuesta:
//   2xx            la ruta acepta escrituras: se puede pausar por API.
//   400/422        la ruta existe y el token pasó la autorización (falla el cuerpo).
//   401/403        el token no tiene permiso de escritura en Ads.
//   404/405        la ruta no existe o no admite ese método.
//
// El log es público: sólo salen rutas con marcadores, códigos HTTP y el texto de error
// de Mercado Libre. Ni títulos, ni montos, ni IDs.
import { CUENTA } from '../../agentes-ml/src/config.mjs';
import { crearCliente } from '../../agentes-ml/src/ml.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';

const SITE = 'MLU';
const ADV = 51659;
const V2 = { 'Api-Version': '2' };
const MAX_ANUNCIOS = 2;

const corto = j => {
  if (!j || typeof j !== 'object') return null;
  const c = Array.isArray(j.cause) ? j.cause.map(x => x?.code ?? x?.message ?? x).slice(0, 3) : undefined;
  return { error: j.error ?? j.code ?? null, message: typeof j.message === 'string' ? j.message.slice(0, 160) : null, ...(c ? { cause: c } : {}), status: j.status && typeof j.status === 'string' ? j.status : undefined };
};

async function main() {
  const fuente = fuenteTokenD1(CUENTA);
  const lectura = crearCliente(fuente, { intentos: 3, concurrencia: 2 });

  const yo = await lectura.get('/users/me');
  if (String(yo?.id) !== String(CUENTA.sellerId)) { console.log('FRENO: el token no es de la cuenta esperada.'); process.exit(1); }
  console.log('Cuenta verificada.');

  // Permisos de la aplicación (scopes), si la API los informa.
  const app = await lectura.sonda(`/applications/${CUENTA.token.appId}`);
  console.log('APP', JSON.stringify({ http: app.status, scopes: app.json?.scopes ?? null, funcionales: app.json?.functional_permissions ?? app.json?.permissions ?? null }));

  // Anuncios ya pausados (sin métricas: alcanza el estado).
  const base = `/advertising/${SITE}/advertisers/${ADV}/product_ads`;
  const r = await lectura.sonda(`${base}/ad_groups/search?limit=10&offset=0&filters[statuses]=paused`, { headers: V2 });
  const pausados = (r.json?.results ?? []).filter(g => String(g.status).toUpperCase() === 'PAUSED').slice(0, MAX_ANUNCIOS);
  console.log('PAUSADOS', JSON.stringify({ http: r.status, encontrados: pausados.length, claves_ad_group: pausados[0] ? Object.keys(pausados[0]).sort() : [] }));
  if (!pausados.length) { console.log('FRENO: no hay anuncios pausados para probar sin cambiar nada.'); return; }

  const estadoDe = async id => {
    const g = await lectura.sonda(`/advertising/${SITE}/product_ads/ad_groups/${id}`, { headers: V2 });
    return String(g.json?.status ?? g.json?.ad_group?.status ?? `http_${g.status}`).toUpperCase();
  };

  for (const [n, g] of pausados.entries()) {
    const id = String(g.id), mlu = g.ad_group_external_id ?? null;
    console.log(`--- Anuncio ${n + 1} (tipo ${g.ad_group_type ?? '?'}) ---`);
    // Los anuncios (ads) dentro del grupo: su forma y su estado.
    const ads = await lectura.sonda(`/advertising/${SITE}/product_ads/ad_groups/${id}/ads`, { headers: V2 });
    const ad = (ads.json?.results ?? ads.json?.ads ?? [])[0] ?? null;
    console.log('ADS', JSON.stringify({ http: ads.status, claves_ad: ad ? Object.keys(ad).sort() : [], estado_ad: ad?.status ?? null }));
    const adId = ad?.id ?? ad?.ad_id ?? null;
    const item = mlu ?? ad?.item_id ?? null;

    const candidatas = [
      ['PUT', '/advertising/{site}/product_ads/ad_groups/{ad_group}', `/advertising/${SITE}/product_ads/ad_groups/${id}`, { status: 'paused' }, V2],
      ['PUT', '/advertising/{site}/product_ads/ad_groups/{ad_group} PAUSED', `/advertising/${SITE}/product_ads/ad_groups/${id}`, { status: 'PAUSED' }, V2],
      ['PUT', '/advertising/{site}/advertisers/{adv}/product_ads/ad_groups/{ad_group}', `${base}/ad_groups/${id}`, { status: 'paused' }, V2],
      ['PATCH', '/advertising/{site}/product_ads/ad_groups/{ad_group}', `/advertising/${SITE}/product_ads/ad_groups/${id}`, { status: 'paused' }, V2],
      ['PUT', '/marketplace/advertising/{site}/product_ads/ad_groups/{ad_group}', `/marketplace/advertising/${SITE}/product_ads/ad_groups/${id}`, { status: 'paused' }, V2],
    ];
    if (adId) {
      candidatas.push(['PUT', '/advertising/{site}/product_ads/ads/{ad}', `/advertising/${SITE}/product_ads/ads/${adId}`, { status: 'paused' }, V2]);
      candidatas.push(['PUT', '/advertising/{site}/product_ads/ad_groups/{ad_group}/ads/{ad}', `/advertising/${SITE}/product_ads/ad_groups/${id}/ads/${adId}`, { status: 'paused' }, V2]);
    }
    if (item) {
      candidatas.push(['PUT', '/advertising/product_ads/items/{item} (v1)', `/advertising/product_ads/items/${item}`, { status: 'paused' }, {}]);
      candidatas.push(['PUT', '/advertising/{site}/product_ads/ads/{item}', `/advertising/${SITE}/product_ads/ads/${item}`, { status: 'paused' }, V2]);
      candidatas.push(['PUT', '/marketplace/advertising/{site}/product_ads/ads/{item}', `/marketplace/advertising/${SITE}/product_ads/ads/${item}`, { status: 'paused' }, V2]);
    }

    if ((await estadoDe(id)) !== 'PAUSED') { console.log('FRENO: el anuncio no figura PAUSED al empezar; no se prueba.'); continue; }
    for (const [metodo, nombre, ruta, cuerpo, headers] of candidatas) {
      let status, json;
      try {
        ({ status, json } = await escribir(fuente, metodo, ruta, cuerpo, headers));
      } catch (e) { status = e.status ?? 0; json = e.detalle ?? { error: e.code }; }
      const despues = await estadoDe(id);
      console.log('PRUEBA', JSON.stringify({ metodo, ruta: nombre, http: status, respuesta: corto(json), estado_despues: despues }));
      if (despues !== 'PAUSED' && !despues.startsWith('HTTP_')) { console.log('FRENO: el estado cambió. Se corta la sonda.'); process.exit(1); }
    }
  }
}

// Escritura directa, un solo intento: ante un 401 no se invalida el token (eso haría
// esperar al cliente a una renovación que no hace falta).
async function escribir(fuente, metodo, ruta, cuerpo, headers) {
  const token = await fuente.getToken();
  const res = await fetch('https://api.mercadolibre.com' + ruta, {
    method: metodo, redirect: 'manual', signal: AbortSignal.timeout(25000),
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(cuerpo),
  });
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

main().catch(e => { console.log('ERROR', JSON.stringify({ code: e.code ?? e.message, status: e.status ?? null })); process.exit(1); });
