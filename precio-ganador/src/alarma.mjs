import { nextInternalEmailAt } from '../../functions/_shared/internal-email-schedule.js';
// Mail de alarma programado para las 20:00 de Montevideo (Resend). Lo usan el workflow cuando una corrida o la
// auditoría fallan, y el vigía cuando una corrida programada no pasó.
//
// Uno por problema por día (Seba, 23/11 y 26/11/2026): el 25/11 llegaron ~30 alarmas iguales juntas a las 20:00,
// una por corrida fallida. La clave de idempotencia es asunto + día de entrega: Resend no repite la misma clave en
// 24 horas (409 si ya se pidió), así que la primera alarma del día queda y las repetidas se descartan.
//
//   node precio-ganador/src/alarma.mjs "Asunto" "Texto"
export async function enviarAlarma({ asunto, texto, aviso = false, fetcher = (...a) => globalThis.fetch(...a) }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { status: 'sin_credenciales' };
  const to = (process.env.PRECIO_GANADOR_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!to.length) return { status: 'sin_destinatario' };
  const from = process.env.REPORT_EMAIL_FROM || 'Amado Libros <web@notificaciones.amadolibros.com>';
  const entrega = nextInternalEmailAt();
  try {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': claveAlarma(asunto, entrega) },
      body: JSON.stringify({ scheduled_at: entrega, from, to, subject: `${aviso ? 'AVISO' : 'ALARMA'} Precio Ganador: ${asunto}`, text: texto, html: `<h2>${aviso ? 'Aviso' : 'Alarma'}: ${esc(asunto)}</h2><p>${esc(texto).replace(/\n/g, '<br>')}</p>` }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 409) return { status: 'ya_avisado' };
    return res.ok ? { status: 'enviado' } : { status: 'error', http: res.status };
  } catch { return { status: 'error_transporte' }; }
}
// Clave estable por problema y por día de entrega. Saca números de corrida, horas y cantidades del asunto
// ("no corre bien desde hace 7 horas" y "... 9 horas" son el mismo problema).
export function claveAlarma(asunto, entrega) {
  const tema = String(asunto).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\d+/g, '').replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
  return `precio-ganador-alarma/${String(entrega).slice(0, 10)}/${tema}`;
}
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await enviarAlarma({ asunto: process.argv[2] ?? 'sin asunto', texto: process.argv[3] ?? '' });
  console.log('Alarma:', JSON.stringify(r));
  if (r.status !== 'enviado' && r.status !== 'ya_avisado') process.exit(1);
}
