// Configuración de los agentes diarios de Mercado Libre de Amado Libros
// (Promociones y medición de Product Ads). Sin credenciales: el token de
// Mercado Libre se lee de D1 (lo renueva el Worker) con los secretos de Actions,
// igual que Precio Ganador.
import { CUENTAS, D1_DATABASE_ID, fechaMontevideo, horaMontevideo } from '../../precio-ganador/src/config.mjs';

export const ML_ORIGIN = 'https://api.mercadolibre.com';
export const TIMEZONE = 'America/Montevideo';
export const SITE_ID = 'MLU';

// La cuenta de Amado Libros y la fila de ml_oauth que renueva el Worker de sync.
export const CUENTA = CUENTAS.libros;
export const APP_ID = CUENTA.token.appId;
export { D1_DATABASE_ID, fechaMontevideo, horaMontevideo };

// Fecha AAAA-MM-DD de Montevideo corrida N días (negativo = hacia atrás).
export function fechaCorrida(dias, base = new Date()) {
  return fechaMontevideo(new Date(base.getTime() + dias * 86400000));
}
