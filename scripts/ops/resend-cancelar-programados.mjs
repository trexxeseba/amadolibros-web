// Cancela en Resend los mails internos ya programados que las reglas del 26/11/2026 sacaron
// (Seba, M4a y M2a): la poda en modo prueba y los avisos y alarmas de Precio Ganador.
//
//   MODO=prueba|real node scripts/ops/resend-cancelar-programados.mjs
//
// prueba: sólo cuenta. real: cancela (POST /emails/{id}/cancel). El log sólo lleva conteos.
// PODA_FECHA (AAAA-MM-DD, opcional): además cancela los mails de la poda de ese día (los 4 del 26/11).
export const CANCELAR = (fecha = process.env.PODA_FECHA) => [/^Poda de anuncios .*\(prueba\)/, /^(ALARMA|AVISO) Precio Ganador/, ...(/^\d{4}-\d{2}-\d{2}$/.test(String(fecha ?? '')) ? [new RegExp(`^Poda de anuncios ${fecha}`)] : [])];
export const seCancela = (m, reglas = CANCELAR()) => String(m?.last_event ?? '').toLowerCase() === 'scheduled' && reglas.some(r => r.test(String(m?.subject ?? '')));

async function main() {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.error('Falta RESEND_API_KEY'); process.exit(1); }
  const real = process.env.MODO === 'real';
  const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const todos = []; let after = null;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`https://api.resend.com/emails?limit=100${after ? `&after=${after}` : ''}`, { headers: H });
    if (!r.ok) { console.error('Resend respondió', r.status, 'al listar'); process.exit(1); }
    const j = await r.json(); const d = Array.isArray(j?.data) ? j.data : [];
    todos.push(...d);
    if (!j?.has_more || !d.length) break;
    after = d.at(-1).id;
  }
  const lista = todos.filter(seCancela);
  const programados = todos.filter(m => String(m?.last_event ?? '').toLowerCase() === 'scheduled').length;
  console.log(`Leídos: ${todos.length} | programados: ${programados} | a cancelar: ${lista.length} (poda en prueba: ${lista.filter(m => /^Poda/.test(m.subject)).length}, Precio Ganador: ${lista.filter(m => /Precio Ganador/.test(m.subject)).length})`);
  if (!real) return;
  let ok = 0, mal = 0;
  for (const m of lista) { const r = await fetch(`https://api.resend.com/emails/${m.id}/cancel`, { method: 'POST', headers: H }); if (r.ok) ok++; else mal++; }
  console.log(`Cancelados: ${ok} | no se pudieron: ${mal}`);
  if (mal) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main();
