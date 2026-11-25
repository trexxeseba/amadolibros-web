// Candado de cuenta: Hermes publica y pausa SOLO en Amado Vintage. Antes de cualquier escritura se
// pregunta a Mercado Libre quién es el dueño del token (/users/me) y, si no es Vintage, se corta.
// Después de crear algo se vuelve a comprobar el dueño del resultado. Nunca se confía en el nombre
// de la cuenta de la configuración: se verifica contra Mercado Libre.
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {CUENTA_HERMES} from './lib.mjs';

const falla = code => Object.assign(new Error(code), {code, fatal: true});

export async function exigirVintage(ml) {
  const esperado = String(CUENTAS[CUENTA_HERMES].sellerId);
  const yo = await ml.get('/users/me').catch(() => null);
  if (String(yo?.id) !== esperado) throw falla('cuenta_equivocada_el_token_no_es_de_vintage');
  return yo;
}

export function exigirItemDeVintage(item) {
  if (String(item?.seller_id) !== String(CUENTAS[CUENTA_HERMES].sellerId)) throw falla('publicacion_en_cuenta_equivocada');
  return item;
}
