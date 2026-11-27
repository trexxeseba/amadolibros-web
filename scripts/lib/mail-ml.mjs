// Reglas de mails automáticos de Mercado Libre (Seba, 26/11/2026):
//  - M5: todo mail lleva arriba, en mayúscula y negrita, APP, PROYECTO y COMETIDO, y abajo cómo
//    desactivarlo o modificarlo.
//  - M3: máximo 1 aviso por problema y por día. Lo frena un registro propio en el repo privado
//    (rama estado/diagnostico, carpeta avisos/AAAA-MM-DD/), no la clave de idempotencia de Resend:
//    el 26/11 Resend aceptó dos alarmas con la misma clave ("no corre hace 9 horas" y "12 horas").
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Arma texto y html con el encabezado y el pie. Función pura.
export function formatoML({ app, proyecto, cometido, texto = '', html = null, desactivar = [] }) {
  const cab = [`APP: ${app}`, `PROYECTO: ${proyecto}`, `COMETIDO: ${cometido}`].map(l => l.toUpperCase());
  const pie = ['Cómo desactivarlo o modificarlo:', ...desactivar.map(l => `- ${l}`)].join('\n');
  return {
    texto: [...cab, '', String(texto), '', pie].join('\n'),
    html: `<div style="font-family:Arial,sans-serif;font-size:14px">${cab.map(l => `<p style="margin:0"><b>${esc(l)}</b></p>`).join('')}<br>`
      + (html ?? `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${esc(texto)}</pre>`)
      + `<hr><pre style="font-family:Arial,sans-serif;white-space:pre-wrap;color:#555">${esc(pie)}</pre></div>`,
  };
}

// Clave estable de un problema: sin números (horas, cantidades, corridas). Función pura.
export const claveProblema = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\d+/g, '').replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'sin-clave';

const fechaUy = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(d);

// true si este problema todavía no se avisó hoy (y lo deja anotado). Crea avisos/<fecha>/<clave>.json
// en el repo privado: si ya existe, GitHub responde 422 y no se avisa de nuevo. Sin ESTADO_TOKEN no
// puede frenar repetidos: avisa igual y lo dice en el log.
export async function avisoUnico(problema, { env = process.env, fetcher = (...a) => globalThis.fetch(...a), ahora = new Date() } = {}) {
  const token = env.ESTADO_TOKEN;
  if (!token) { console.log('aviso-unico: sin ESTADO_TOKEN, no se puede frenar repetidos'); return true; }
  const repo = env.ESTADO_REPO || 'trexxeseba/amadolibros-privado', rama = env.AVISOS_RAMA || 'estado/diagnostico';
  const ruta = `avisos/${fechaUy(ahora)}/${claveProblema(problema)}.json`;
  try {
    const res = await fetcher(`https://api.github.com/repos/${repo}/contents/${ruta}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `aviso ${ruta}`, branch: rama, content: Buffer.from(JSON.stringify({ problema: claveProblema(problema), hora: ahora.toISOString() })).toString('base64') }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 201) return true;
    if (res.status === 422 || res.status === 409) return false; // ya avisado hoy
    console.log('aviso-unico: GitHub respondió', res.status, '- se avisa igual');
    return true;
  } catch { console.log('aviso-unico: sin conexión con GitHub - se avisa igual'); return true; }
}
