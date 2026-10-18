// Paso 0 del piloto: captura de SOLO LECTURA del uso facturable de la cuenta, con
// el token ya configurado en Actions (permiso Billing Read; no se crean ni
// amplían credenciales), y conversión ESTRICTA a informe de uso.
//
// Endpoint: GET /accounts/{account_id}/billable-usage (documentado por Cloudflare
// como "Get Account Billable Usage, Version 1, Alpha"). Verificado contra la
// documentación oficial (resultados de búsqueda; el sitio no es accesible desde el
// entorno de desarrollo), NO contra la API en vivo. La documentación no muestra
// cómo aparecen las transformaciones de Images ni confirma ConsumedQuantity, por
// eso el conversor FALLA CERRADO ante cualquier forma que no reconozca: sin
// informe no se inicializa ni se ejecuta la generación. No hay excepción ni cero
// por omisión. La primera captura real se revisa a mano antes de relajar nada.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const DEFAULT_USAGE_URL = 'https://api.cloudflare.com/client/v4/accounts/{account_id}/billable-usage?from={from}&to={to}';
export const USAGE_SOURCE = 'cloudflare-billable-usage';

export function usageUrl({ template = DEFAULT_USAGE_URL, accountId, now = new Date() }) {
  if (!/^[a-f0-9]{32}$/.test(accountId || '')) throw new Error('invalid-account');
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const url = new URL(template.replace('{account_id}', accountId).replace('{from}', first).replace('{to}', now.toISOString().slice(0, 10)));
  if (url.protocol !== 'https:' || url.hostname !== 'api.cloudflare.com' || url.username || url.password) throw new Error('usage-host-not-allowed');
  return url;
}

export async function captureImagesUsage({ fetchFn = fetch, token, accountId, now = new Date(), template }) {
  if (!token) throw new Error('usage-token-missing');
  const url = usageUrl({ template, accountId, now });
  const response = await fetchFn(url, { method: 'GET', redirect: 'manual', headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000) });
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 5_000_000) throw new Error('usage-response-too-large');
  if (!response.ok) throw new Error(`usage-http-${response.status}`);
  return { status: response.status, observed_at: now.toISOString(), raw_sha256: createHash('sha256').update(body).digest('hex'),
    bytes: body.length, body };
}

const isImagesTransformations = row => {
  const text = field => String(row?.[field] ?? '');
  return /image/i.test(`${text('ServiceFamilyName')} ${text('ServiceName')}`) &&
    /transformation/i.test(`${text('ConsumedUnit')} ${text('PricingUnit')} ${text('ServiceName')} ${text('ChargeDescription')} ${text('SkuName')}`);
};

// Convierte la captura cruda en el informe que exige el libro mayor. Estricto:
// - forma {success:true, result:[...]}; cualquier otra → usage-shape-unrecognized
// - al menos una fila de Images/transformaciones (cero filas ≠ cero uso: no se sabe)
// - cantidad CRUDA consumida (ConsumedQuantity). PricingQuantity podría excluir la
//   cuota incluida; no se usa como sustituto
// - periodo de cada fila dentro del mes UTC en curso (la API agrupa por ciclo de
//   facturación; el cupo de Images es mensual)
export function usageReportFromCapture(captured, { now = new Date() } = {}) {
  let parsed;
  try { parsed = JSON.parse(captured.body.toString('utf8')); } catch { throw new Error('usage-shape-unrecognized'); }
  if (parsed?.success !== true || !Array.isArray(parsed.result)) throw new Error('usage-shape-unrecognized');
  const rows = parsed.result.filter(isImagesTransformations);
  if (rows.length === 0) throw new Error('usage-images-not-found');
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  let total = 0;
  for (const row of rows) {
    const quantity = row.ConsumedQuantity;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) throw new Error('usage-quantity-unavailable');
    const start = Date.parse(row.ChargePeriodStart), end = Date.parse(row.ChargePeriodEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < monthStart || end > now.getTime() + 24 * 3600e3) throw new Error('usage-period-mismatch');
    total += Math.ceil(quantity);
  }
  if (!Number.isSafeInteger(total)) throw new Error('usage-quantity-unavailable');
  return { source: USAGE_SOURCE, period: now.toISOString().slice(0, 7), billed_transformations: total,
    observed_at: captured.observed_at, raw_sha256: captured.raw_sha256, rows_matched: rows.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [rawPath, reportPath] = process.argv.slice(2);
  if (!rawPath || !reportPath) throw new Error('usage: capture-images-usage raw-output.json usage-report.json');
  try {
    const now = new Date();
    const captured = await captureImagesUsage({ token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      template: process.env.IMAGES_USAGE_URL_TEMPLATE || undefined, now });
    await writeFile(rawPath, captured.body, { flag: 'wx', mode: 0o600 }); // la captura cruda se conserva SIEMPRE para revisión
    const report = usageReportFromCapture(captured, { now });         // si falla: sin informe, código de salida 1
    await writeFile(reportPath, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ usage_available: true, ...report }));
  } catch (error) {
    // Código acotado: nunca el mensaje de red completo ni el token.
    console.error(JSON.stringify({ usage_available: false, generation: 'stopped',
      reason: /^usage-[a-z0-9-]+$|^invalid-account$/.test(error.message) ? error.message : 'usage-request-failed' }));
    process.exitCode = 1;
  }
}
