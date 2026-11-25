// Configuración de Precios Amado: dónde viven credenciales y estado, y constantes
// del negocio. Nada de esto se versiona con valores: las credenciales llegan por
// variables de entorno (GitHub Actions) o por ~/.amado-precios/credentials.json
// (PC local), siempre fuera del repositorio.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

export const SELLER_ID = '440298103';
export const SITE_ID = 'MLU';
export const TIMEZONE = 'America/Montevideo';
export const ML_ORIGIN = 'https://api.mercadolibre.com';
export const DESTINATARIO = 'sebastian@amadolibros.com';

export const HOME = process.env.PRECIOS_AMADO_HOME || join(homedir(), '.amado-precios');
export const STATE_DIR = join(HOME, 'state');
export const REPORT_DIR = join(HOME, 'reportes');

// Credenciales de la app de Mercado Libre (grant client_credentials, sin refresh
// token: no interfiere con el OAuth rotativo del Worker en D1).
export function loadCredentials() {
  const fromEnv = { app_id: process.env.ML_PRECIOS_APP_ID, client_secret: process.env.ML_PRECIOS_CLIENT_SECRET };
  if (fromEnv.app_id && fromEnv.client_secret) return { ...fromEnv, origen: 'env' };
  const file = join(HOME, 'credentials.json');
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const app = data.apps?.monitor ?? data;
    if (app.app_id && app.client_secret) return { app_id: String(app.app_id), client_secret: String(app.client_secret), origen: 'credentials.json' };
  }
  throw new Error('Faltan credenciales: ML_PRECIOS_APP_ID y ML_PRECIOS_CLIENT_SECRET, o ' + file);
}

// Configuración comercial opcional (techos por publicación, etc.): HOME/config.json
//   { "techos": { "MLU123": 1500 }, "correo": { "destinatario": "..." } }
export function loadConfig() {
  const file = join(HOME, 'config.json');
  if (!existsSync(file)) return { techos: {} };
  try { const c = JSON.parse(readFileSync(file, 'utf8')); return { techos: {}, ...c }; } catch { return { techos: {} }; }
}

export const montevideoNow = (d = new Date()) => d.toLocaleString('es-UY', { timeZone: TIMEZONE, hour12: false });
export const montevideoDate = (d = new Date()) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p; // YYYY-MM-DD
};
