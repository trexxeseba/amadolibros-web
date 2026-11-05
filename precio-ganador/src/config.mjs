// Configuración de Precio Ganador. Un solo código para las dos cuentas.
// Nada de credenciales acá: el token de Mercado Libre se lee de D1 (lo mantiene
// el Worker o el panel) por la API de Cloudflare, con secretos de Actions.

export const ML_ORIGIN = 'https://api.mercadolibre.com';
export const TIMEZONE = 'America/Montevideo';

// Regla de negocio (cerrada por Seba el 04/11/2026).
export const UMBRAL_UYU = 360;          // diferencia máxima que se acepta bajar
// Tope de porcentaje (Seba, 04/11/2026): nunca bajar más del 30 % del precio original.
export const TOPE_PCT = 0.30;
export const STOCK_DEMANDA_DEFAULT = 5; // stock fijo en las a demanda al bajarles el precio
export const MAX_CAMBIOS_POR_CORRIDA = 400; // freno de seguridad: más que esto, se corta

export const CUENTAS = {
  libros: {
    clave: 'libros',
    nombre: 'Amado Libros',
    sellerId: '440298103',
    // Fila de ml_oauth que renueva el Worker de sync (cron cada 5 min).
    token: { tabla: 'ml_oauth', appId: '4741021817925208' },
    // Libros: el stock no se toca nunca (tiene libros de estantería mezclados).
    tocarStockDemanda: false,
    umbral: 360,
    topePct: 0.30,
    minimo: null,
    habilitada: true,
  },
  // Vintage NO corre con este sistema (Seba, 04/11/2026): su precio competitivo lo
  // maneja el motor de la PC (scripts/vintage-local/stock-sync.mjs, modo correct),
  // que conoce el costo y nunca baja del 18 % de margen. Correr los dos los haría
  // pisarse. Queda configurada para no perder el dato, pero deshabilitada.
  vintage: {
    clave: 'vintage',
    nombre: 'Amado Vintage',
    sellerId: '2341378249',
    // Fila de ml_oauth_sellers que renueva el panel (meli-vintage-token.js).
    token: { tabla: 'ml_oauth_sellers', appId: '4741021817925208' },
    // Stock fijo en las a demanda (Seba, 05/11/2026): al bajarle el precio a una
    // publicación a demanda, stock 5, conservando sus días de disponibilidad. Al volver
    // al precio original se restaura el stock que tenía.
    tocarStockDemanda: true,
    // Regla simple de Vintage (Seba, 05/11/2026): si pierde y la diferencia con el
    // precio para ganar es menor a 400, bajar a ese precio. Sin tope de porcentaje
    // ni piso por costo. Único piso: nunca menos de UYU 1.500.
    umbral: 400,
    topePct: null,
    minimo: 1500,
    pisoPorCosto: false,
    habilitada: false,
  },
};

// D1 amadolibros-orders-production (worker-sync/wrangler.toml).
export const D1_DATABASE_ID = '6dc8dc3a-2d4f-4045-b428-14323c7b0bcd';

export function fechaMontevideo(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function horaMontevideo(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', hour12: false }).format(d));
}
