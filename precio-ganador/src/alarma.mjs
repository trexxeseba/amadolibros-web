import { nextInternalEmailAt } from '../../functions/_shared/internal-email-schedule.js';
import { formatoML, avisoUnico } from '../../scripts/lib/mail-ml.mjs';
// Mail de alarma programado para las 20:00 de Montevideo (Resend).
//
// Reglas de Seba del 26/11/2026:
//  - M2a: los fallos y avisos de Precio Ganador NO van por mail (los lee el operador y los resume con 2
//    soluciones). Por eso sólo se manda si el workflow lo pide con ALARMAS_POR_MAIL=si (hoy: el vigía del
//    latido de la tarea de precios sin catálogo). Sin eso devuelve 'sin_mail_por_regla' y no falla.
//  - M3a: máximo 1 aviso por problema y por día, con un registro propio en el repo privado
//    (scripts/lib/mail-ml.mjs): la clave de Resend no frenaba repetidos.
//  - M5a: encabezado APP / PROYECTO / COMETIDO y pie con cómo desactivarlo (MAIL_APP, MAIL_PROYECTO,
//    MAIL_COMETIDO, MAIL_DESACTIVAR separadas por "|").
//
//   node precio-ganador/src/alarma.mjs "Asunto" "Texto"
export async function enviarAlarma({ asunto, texto, aviso = false, env = process.env, fetcher = (...a) => globalThis.fetch(...a) }) {
  if (String(env.ALARMAS_POR_MAIL ?? '').toLowerCase() !== 'si') { console.log('Alarma sin mail (regla del 26/11):', asunto); return { status: 'sin_mail_por_regla' }; }
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return { status: 'sin_credenciales' };
  const to = (env.PRECIO_GANADOR_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!to.length) return { status: 'sin_destinatario' };
  if (!(await avisoUnico(asunto, { env, fetcher }))) return { status: 'ya_avisado' };
  const from = env.REPORT_EMAIL_FROM || 'Amado Libros <web@notificaciones.amadolibros.com>';
  const entrega = nextInternalEmailAt();
  const prefijo = env.MAIL_PREFIJO || `${aviso ? 'AVISO' : 'ALARMA'} Precio Ganador`;
  const cuerpo = formatoML({ app: env.MAIL_APP || 'GitHub Actions de amadolibros-web', proyecto: env.MAIL_PROYECTO || 'Precio Ganador', cometido: env.MAIL_COMETIDO || 'Avisar cuando una automatización de Mercado Libre deja de andar',
    texto, desactivar: String(env.MAIL_DESACTIVAR || 'Apagar los mails de alarma: sacar ALARMAS_POR_MAIL=si del workflow que manda este aviso.').split('|') });
  try {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': claveAlarma(asunto, entrega) },
      body: JSON.stringify({ scheduled_at: entrega, from, to, subject: `${prefijo}: ${asunto}`, text: cuerpo.texto, html: cuerpo.html }),
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await enviarAlarma({ asunto: process.argv[2] ?? 'sin asunto', texto: process.argv[3] ?? '' });
  console.log('Alarma:', JSON.stringify(r));
  if (!['enviado', 'ya_avisado', 'sin_mail_por_regla'].includes(r.status)) process.exit(1);
}
