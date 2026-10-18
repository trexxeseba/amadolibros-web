// Paso 0 del piloto: captura CRUDA y de solo lectura del uso facturable de la
// cuenta, con el token ya configurado en Actions. No interpreta el contenido:
// guarda la respuesta tal cual y su SHA-256. Convertirla en el informe de uso
// que exige el libro mayor se hace DESPUÉS de revisar la forma real de la
// respuesta (no se adivina). Si falla, la generación no se inicializa.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// SIN VERIFICAR contra la API en vivo (este entorno no tiene acceso a la
// documentación ni a la API). Se parametriza para corregirlo sin tocar la lógica.
export const DEFAULT_USAGE_URL = 'https://api.cloudflare.com/client/v4/accounts/{account_id}/billing/usage/paygo?from={from}&to={to}';

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error('usage: capture-images-usage raw-output.json');
  try {
    const captured = await captureImagesUsage({ token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      template: process.env.IMAGES_USAGE_URL_TEMPLATE || undefined });
    await writeFile(outputPath, captured.body, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ status: captured.status, observed_at: captured.observed_at, raw_sha256: captured.raw_sha256, bytes: captured.bytes }));
  } catch (error) {
    // Código acotado: nunca el mensaje de red completo ni el token.
    console.error(JSON.stringify({ usage_available: false, reason: /^usage-[a-z0-9-]+$|^invalid-account$/.test(error.message) ? error.message : 'usage-request-failed' }));
    process.exitCode = 1;
  }
}
