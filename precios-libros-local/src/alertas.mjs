// Alertas por email (SMTP de Gmail con contraseña de aplicación) a ALERTA_DESTINO.
// Variables: ALERTA_SMTP_USER (la cuenta de Gmail que envía) y ALERTA_SMTP_PASS (la
// contraseña de aplicación de 16 letras). Nunca van al repo ni al log.
// Sin esas variables, la alerta queda en datos/alertas.log.
import tls from 'node:tls';
import { appendFileSync } from 'node:fs';
import { ALERTA_DESTINO } from '../config.mjs';

export async function alertar({ asunto, cuerpo, dir, env = process.env }) {
  const linea = `[${new Date().toISOString()}] ${asunto}\n${cuerpo}\n\n`;
  try { appendFileSync(`${dir}/alertas.log`, linea); } catch {}
  const user = env.ALERTA_SMTP_USER, pass = env.ALERTA_SMTP_PASS;
  if (!user || !pass || !(env.ALERTA_DESTINO || ALERTA_DESTINO)) return { enviado: false, motivo: 'smtp_no_configurado' };
  try { await smtp({ host: 'smtp.gmail.com', port: 465, user, pass, from: user, to: env.ALERTA_DESTINO || ALERTA_DESTINO, asunto, cuerpo }); return { enviado: true }; }
  catch (e) { try { appendFileSync(`${dir}/alertas.log`, `  (no se pudo enviar: ${e.message})\n`); } catch {} return { enviado: false, motivo: e.message }; }
}

function smtp({ host, port, user, pass, from, to, asunto, cuerpo }) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, servername: host }, () => {});
    s.setTimeout(30000, () => { s.destroy(); reject(new Error('smtp_timeout')); });
    let buf = '', paso = 0;
    const b64 = t => Buffer.from(t, 'utf8').toString('base64');
    const msg = [`From: Motor de precios <${from}>`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(asunto)}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(cuerpo).replace(/.{76}/g, '$&\r\n'), '.'].join('\r\n');
    const pasos = [[220, 'EHLO amado-precios'], [250, 'AUTH LOGIN'], [334, b64(user)], [334, b64(pass)], [235, `MAIL FROM:<${from}>`], [250, `RCPT TO:<${to}>`], [250, 'DATA'], [354, msg], [250, 'QUIT']];
    s.on('data', d => {
      buf += d.toString();
      const lineas = buf.split('\r\n'); buf = lineas.pop();
      for (const l of lineas) {
        if (/^\d{3}-/.test(l)) continue;           // respuesta multilínea
        const code = Number(l.slice(0, 3));
        if (paso >= pasos.length) { s.end(); return resolve(); }
        if (code !== pasos[paso][0]) { s.destroy(); return reject(new Error(`smtp_${code}`)); }
        s.write(pasos[paso][1] + '\r\n'); paso++;
      }
    });
    s.on('error', reject);
    s.on('end', () => (paso >= pasos.length ? resolve() : reject(new Error('smtp_cerrado'))));
  });
}
