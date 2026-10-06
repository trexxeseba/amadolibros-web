// Lee y —sólo con confirmación explícita— apaga o enciende el autofeed de
// Merchant Center (la «recopilación automática de datos del sitio web»).
//
// Por qué un archivo aparte y no dentro de merchant-readonly-audit.mjs: ese
// script tiene un contrato de SÓLO LECTURA fijado por una prueba que prohíbe
// POST/PATCH/PUT/DELETE en su código fuente
// (functions/__tests__/merchant-readonly-audit.test.js:127). Agregarle una
// escritura rompería esa garantía para todo el resto de la auditoría.
//
// Autenticación: NO hay claves acá. El token llega por Workload Identity
// Federation desde GitHub Actions, con el mismo scope que ya usa la auditoría
// (https://www.googleapis.com/auth/content).
//
// La API: Merchant API v1. `v1beta` se apagó el 28 de febrero de 2026, así que
// la ruta beta ya no sirve.
//   GET   /accounts/v1/accounts/{id}/autofeedSettings
//   PATCH /accounts/v1/accounts/{id}/autofeedSettings?updateMask=enableProducts
//
// Reversibilidad: encender de nuevo es una sola llamada con `true`. Google
// avisa que al re-habilitar los productos pueden tardar hasta 24 horas en
// volver a aparecer, así que apagar no es gratis de deshacer en el minuto.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API_ROOT = 'https://merchantapi.googleapis.com';
const DEFAULT_ACCOUNT_ID = '5330457716';
const TIMEOUT_MS = 60_000;

// Palabra que hay que escribir para que una escritura ocurra. Sin esto, la
// única acción posible es leer.
export const CONFIRMACION_REQUERIDA = 'APAGAR';
export const CONFIRMACION_ENCENDER = 'ENCENDER';

function texto(valor) {
  return String(valor ?? '').trim();
}

/**
 * Decide qué se va a hacer, antes de tocar la red. Separado de la ejecución
 * para poder probar cada combinación sin llamar a Google.
 *
 * Reglas:
 *  - `leer` nunca escribe.
 *  - `apagar` exige la palabra exacta APAGAR.
 *  - `encender` exige la palabra exacta ENCENDER.
 *  - Una confirmación que no corresponde a la acción NO habilita la escritura:
 *    escribir APAGAR no puede encender nada.
 */
export function resolverAccion({ accion, confirmacion } = {}) {
  const pedida = texto(accion).toLowerCase() || 'leer';
  const palabra = texto(confirmacion);

  if (pedida === 'leer') return { escribe: false, accion: 'leer', enableProducts: null };

  if (pedida === 'apagar') {
    if (palabra !== CONFIRMACION_REQUERIDA) {
      return {
        escribe: false,
        accion: 'leer',
        enableProducts: null,
        motivo: `Para apagar hay que escribir exactamente ${CONFIRMACION_REQUERIDA}. Se leyó el estado sin cambiar nada.`,
      };
    }
    return { escribe: true, accion: 'apagar', enableProducts: false };
  }

  if (pedida === 'encender') {
    if (palabra !== CONFIRMACION_ENCENDER) {
      return {
        escribe: false,
        accion: 'leer',
        enableProducts: null,
        motivo: `Para encender hay que escribir exactamente ${CONFIRMACION_ENCENDER}. Se leyó el estado sin cambiar nada.`,
      };
    }
    return { escribe: true, accion: 'encender', enableProducts: true };
  }

  return {
    escribe: false,
    accion: 'leer',
    enableProducts: null,
    motivo: `Acción desconocida: ${pedida}. Se leyó el estado sin cambiar nada.`,
  };
}

async function pedir(url, { accessToken, method = 'GET', body = null, fetchFn = fetch } = {}) {
  const response = await fetchFn(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const error = new Error(data?.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.apiStatus = data?.error?.status || null;
    throw error;
  }
  return data || {};
}

export function urlAutofeed(accountId, { updateMask = null } = {}) {
  const base = `${API_ROOT}/accounts/v1/accounts/${accountId}/autofeedSettings`;
  return updateMask ? `${base}?updateMask=${encodeURIComponent(updateMask)}` : base;
}

export async function leerAutofeed({ accountId, accessToken, fetchFn = fetch }) {
  return pedir(urlAutofeed(accountId), { accessToken, fetchFn });
}

export async function escribirAutofeed({ accountId, accessToken, enableProducts, fetchFn = fetch }) {
  return pedir(urlAutofeed(accountId, { updateMask: 'enableProducts' }), {
    accessToken,
    method: 'PATCH',
    body: { enableProducts: Boolean(enableProducts) },
    fetchFn,
  });
}

/**
 * Un 403 acá no es un error de código: es que la cuenta de servicio tiene
 * lectura pero no administración en Merchant Center. Se informa como tal para
 * que nadie salga a depurar el script.
 */
export function explicarError(error, { escribiendo = false } = {}) {
  const status = error?.status ?? null;
  if (status === 403) {
    return escribiendo
      ? 'HTTP 403 al escribir: la cuenta de servicio ga4-reporter puede leer Merchant Center pero no administrarlo. Hay que darle permiso de administrador en Merchant Center (Personas y acceso). No es un problema del script.'
      : 'HTTP 403 al leer: la cuenta de servicio no tiene acceso a esta cuenta de Merchant Center.';
  }
  if (status === 404) {
    return 'HTTP 404: la cuenta de Merchant no existe o la API Merchant no está habilitada en el proyecto.';
  }
  if (status === 400) {
    return `HTTP 400: ${error?.message || 'pedido inválido'}. Si menciona v1beta, la ruta quedó vieja: v1beta se apagó el 28/02/2026.`;
  }
  return `HTTP ${status ?? '?'}: ${error?.message || 'error desconocido'}`;
}

export function resumen({ accountId, plan, antes, despues, error = null }) {
  const lineas = ['## Autofeed de Merchant Center', ''];
  lineas.push(`- Cuenta: ${accountId}`);
  lineas.push(`- Acción ejecutada: **${plan.accion}**`);
  if (plan.motivo) lineas.push(`- ${plan.motivo}`);
  lineas.push('');

  if (antes) {
    lineas.push(`- Estado antes: \`enableProducts\` = **${antes.enableProducts === true}**`);
    lineas.push(`- Elegible para autofeed: ${antes.eligible === true}`);
  } else {
    lineas.push('- Estado antes: no se pudo leer.');
  }

  if (plan.escribe) {
    if (despues) {
      lineas.push(`- Estado después: \`enableProducts\` = **${despues.enableProducts === true}**`);
      const cambio = antes && antes.enableProducts !== despues.enableProducts;
      lineas.push(cambio
        ? '- **El cambio se aplicó.**'
        : '- La API respondió bien pero el valor no cambió; revisar si ya estaba así.');
      if (despues.enableProducts === false) {
        lineas.push('');
        lineas.push('Para revertir: correr este workflow con `accion: encender` y la palabra `ENCENDER`. Google avisa que al re-habilitar los productos pueden tardar hasta 24 horas en volver a aparecer.');
      }
    } else {
      lineas.push('- Estado después: la escritura no se completó.');
    }
  }

  if (error) {
    lineas.push('');
    lineas.push(`**No se completó:** ${error}`);
  }

  return `${lineas.join('\n')}\n`;
}

export async function main({ env = process.env, fetchFn = fetch } = {}) {
  const accountId = texto(env.MERCHANT_ACCOUNT_ID) || DEFAULT_ACCOUNT_ID;
  const accessToken = texto(env.MERCHANT_ACCESS_TOKEN);
  const outputDir = texto(env.MERCHANT_OUTPUT_DIR) || 'artifacts/merchant-autofeed';

  if (!/^\d+$/.test(accountId)) throw new Error('MERCHANT_ACCOUNT_ID inválido.');
  if (!accessToken) throw new Error('Falta MERCHANT_ACCESS_TOKEN.');

  const plan = resolverAccion({
    accion: env.MERCHANT_AUTOFEED_ACCION,
    confirmacion: env.MERCHANT_AUTOFEED_CONFIRMACION,
  });

  let antes = null;
  let despues = null;
  let fallo = null;

  try {
    antes = await leerAutofeed({ accountId, accessToken, fetchFn });
  } catch (error) {
    fallo = explicarError(error, { escribiendo: false });
  }

  if (!fallo && plan.escribe) {
    // No se escribe si ya está en el valor pedido: evita un PATCH inútil y
    // deja el informe diciendo la verdad en vez de «aplicado».
    if (antes?.enableProducts === plan.enableProducts) {
      plan.motivo = `Ya estaba en ${plan.enableProducts}; no se escribió nada.`;
      plan.escribe = false;
    } else {
      try {
        despues = await escribirAutofeed({
          accountId, accessToken, enableProducts: plan.enableProducts, fetchFn,
        });
      } catch (error) {
        fallo = explicarError(error, { escribiendo: true });
      }
    }
  }

  const informe = {
    schemaVersion: 1,
    accountId,
    generadoEn: new Date().toISOString(),
    accion: plan.accion,
    escribio: Boolean(plan.escribe && despues),
    antes: antes ?? null,
    despues: despues ?? null,
    error: fallo,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'autofeed.json'), `${JSON.stringify(informe, null, 2)}\n`, 'utf8');
  const texto_resumen = resumen({ accountId, plan, antes, despues, error: fallo });
  await writeFile(path.join(outputDir, 'report-summary.md'), texto_resumen, 'utf8');
  process.stdout.write(texto_resumen);

  if (fallo) {
    process.exitCode = 1;
  }
  return informe;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
