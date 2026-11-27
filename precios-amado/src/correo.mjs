// Envío por Resend, el mismo proveedor y remitente verificado que ya usan los
// informes del proyecto. Sin RESEND_API_KEY no se manda nada y se avisa.
// Idempotency-Key: si el envío se corta después de que Resend lo aceptó, el
// reintento con la misma clave no duplica el correo.
import { DESTINATARIO } from './config.mjs';
import { formatoML, avisoUnico } from '../../scripts/lib/mail-ml.mjs';

export async function enviarCorreo({ asunto, html, texto, idempotencia, adjunto, fetcher = (...a) => globalThis.fetch(...a) }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.REPORT_EMAIL_FROM || 'Amado Libros <web@notificaciones.amadolibros.com>';
  const to = (process.env.PRECIOS_EMAIL_TO || DESTINATARIO).split(',').map(s => s.trim()).filter(Boolean);
  if (!apiKey) return { status: 'sin_credenciales' };
  // M3a (Seba 26/11): un aviso por tema por día. M5a: encabezado APP/PROYECTO/COMETIDO y pie.
  if (!(await avisoUnico(`precios-amado-${asunto}`, { fetcher }))) return { status: 'ya_enviado' };
  ({ texto, html } = formatoML({ app: 'GitHub Actions de amadolibros-web', proyecto: 'Precios Amado', cometido: 'Avisar competencia, alertas de catálogo y oportunidades de subida en Mercado Libre', texto, html, desactivar: ['Desactivar el workflow "precios-amado" en Actions, o cambiar PRECIOS_EMAIL_TO.'] }));
  try {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(idempotencia ? { 'Idempotency-Key': idempotencia } : {}) },
      body: JSON.stringify({ from, to, subject: asunto, html, text: texto, ...(adjunto ? { attachments: [{ filename: adjunto.nombre, content: Buffer.from(adjunto.contenido, 'utf8').toString('base64') }] } : {}) }), signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { status: 'error', http: res.status, detalle: body?.name ?? null };
    return { status: 'enviado', id: body.id ?? null };
  } catch (e) {
    return { status: 'error', detalle: e?.name === 'TimeoutError' ? 'timeout' : 'transporte' };
  }
}
