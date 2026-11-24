import { nextInternalEmailAt } from '../functions/_shared/internal-email-schedule.js';
// Manda el resumen diario por mail (Resend). Uso: node hermes-monitor/mail.mjs <resumen.txt>
import fs from 'node:fs/promises';
const texto = await fs.readFile(process.argv[2], 'utf8').catch(() => null);
const apiKey = process.env.RESEND_API_KEY;
const to = String(process.env.HERMES_EMAIL_TO || 'adm@amadolibros.com').split(',').map(s => s.trim()).filter(Boolean);
if (!texto || !apiKey) { console.log('sin resumen o sin credenciales: no se envía'); process.exit(0); }
const res = await fetch('https://api.resend.com/emails', {
  method: 'POST', signal: AbortSignal.timeout(30000),
  headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json'},
  body: JSON.stringify({ scheduled_at: nextInternalEmailAt(),from: process.env.REPORT_EMAIL_FROM || 'Amado Libros <web@notificaciones.amadolibros.com>', to, subject: `Hermes: ${texto.split('\n')[0].replace('Chequeo de Hermes del ', 'chequeo del ').split(':')[0]}`, text: texto}),
}).catch(() => null);
console.log(res?.ok ? 'mail programado para las 20:00 de Montevideo' : `mail no enviado (${res?.status ?? 'sin respuesta'})`);
