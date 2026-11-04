// Envío por Resend, el mismo proveedor y remitente verificado que ya usan los
// informes del proyecto. Sin RESEND_API_KEY no se manda nada y se avisa.
import { DESTINATARIO } from './config.mjs';

export async function enviarCorreo({ asunto, html, texto, fetcher = (...a) => globalThis.fetch(...a) }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.REPORT_EMAIL_FROM || 'Amado Libros <web@notificaciones.amadolibros.com>';
  const to = (process.env.PRECIOS_EMAIL_TO || DESTINATARIO).split(',').map(s => s.trim()).filter(Boolean);
  if (!apiKey) return { status: 'sin_credenciales' };
  const res = await fetcher('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject: asunto, html, text: texto }), signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { status: 'error', http: res.status, detalle: body?.message ?? body?.name ?? null };
  return { status: 'enviado', id: body.id ?? null, to };
}
