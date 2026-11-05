// Mail de alarma inmediato (Resend). Lo usan el workflow cuando una corrida o la
// auditoría fallan, y el vigía cuando una corrida programada no pasó.
//
//   node precio-ganador/src/alarma.mjs "Asunto" "Texto"
export async function enviarAlarma({ asunto, texto, aviso = false, fetcher = (...a) => globalThis.fetch(...a) }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { status: 'sin_credenciales' };
  const to = (process.env.PRECIO_GANADOR_EMAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!to.length) return { status: 'sin_destinatario' };
  const from = process.env.REPORT_EMAIL_FROM || 'Amado Libros <web@notificaciones.amadolibros.com>';
  try {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject: `${aviso ? 'AVISO' : 'ALARMA'} Precio Ganador: ${asunto}`, text: texto, html: `<h2>${aviso ? 'Aviso' : 'Alarma'}: ${esc(asunto)}</h2><p>${esc(texto).replace(/\n/g, '<br>')}</p>` }),
      signal: AbortSignal.timeout(30000),
    });
    return res.ok ? { status: 'enviado' } : { status: 'error', http: res.status };
  } catch { return { status: 'error_transporte' }; }
}
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await enviarAlarma({ asunto: process.argv[2] ?? 'sin asunto', texto: process.argv[3] ?? '' });
  console.log('Alarma:', JSON.stringify(r));
  if (r.status !== 'enviado') process.exit(1);
}
