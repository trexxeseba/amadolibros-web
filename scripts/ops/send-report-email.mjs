/**
 * Manda un informe por correo, vía Resend.
 *
 * Los reportes del proyecto ya se calculan todos los días y terminan en el
 * resumen del job y en un ZIP que hay que descargar. Ese es el motivo práctico
 * por el que nadie los lee. Esto los saca de GitHub y los pone en la casilla.
 *
 * Usa el mismo proveedor y el mismo remitente que los correos de venta, que ya
 * están configurados y verificados. No inventa un segundo camino de envío.
 *
 * El correo va en texto y en HTML: el texto es el markdown tal cual (sirve de
 * respaldo si el cliente no renderiza), y el HTML es una traducción mínima
 * —títulos, listas, tablas y negritas— para que se pueda leer de un vistazo
 * desde el teléfono. No se usa una librería de markdown: son cuatro reglas y
 * traerse un parser entero para esto costaría más de lo que resuelve.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function asText(value) {
  return String(value ?? '').trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(texto) {
  // Se escapa PRIMERO y se aplican las marcas después, para que un título que
  // traiga `<` o `&` no pueda inyectar etiquetas en el correo.
  return escapeHtml(texto)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
}

function celdas(linea) {
  return linea.replace(/^\||\|$/g, '').split('|').map(celda => celda.trim());
}

function esSeparadorDeTabla(linea) {
  return /^\|?[\s:-]*-[-\s|:]*\|?$/.test(linea) && linea.includes('-');
}

export function markdownToHtml(markdown) {
  const lineas = String(markdown ?? '').split('\n');
  const salida = [];
  let enLista = false;
  let enTabla = false;

  const cerrarLista = () => { if (enLista) { salida.push('</ul>'); enLista = false; } };
  const cerrarTabla = () => { if (enTabla) { salida.push('</tbody></table>'); enTabla = false; } };

  for (let i = 0; i < lineas.length; i += 1) {
    const linea = lineas[i];
    const limpia = linea.trim();

    if (!limpia) { cerrarLista(); cerrarTabla(); continue; }

    const titulo = limpia.match(/^(#{1,3})\s+(.*)$/);
    if (titulo) {
      cerrarLista(); cerrarTabla();
      const nivel = titulo[1].length;
      salida.push(`<h${nivel}>${inline(titulo[2])}</h${nivel}>`);
      continue;
    }

    if (limpia.startsWith('|')) {
      if (esSeparadorDeTabla(limpia)) continue;
      cerrarLista();
      if (!enTabla) {
        // La primera fila de un bloque de tabla es el encabezado.
        salida.push('<table><thead><tr>' + celdas(limpia).map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
        enTabla = true;
        continue;
      }
      salida.push('<tr>' + celdas(limpia).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>');
      continue;
    }
    cerrarTabla();

    const item = limpia.match(/^[-*]\s+(.*)$/);
    if (item) {
      if (!enLista) { salida.push('<ul>'); enLista = true; }
      salida.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    cerrarLista();

    salida.push(`<p>${inline(limpia)}</p>`);
  }

  cerrarLista();
  cerrarTabla();

  return [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#111823;max-width:640px">',
    '<style>table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #d4dce5;padding:6px 9px;text-align:left;font-size:14px}th{background:#f2f5f8}h1{font-size:20px}h2{font-size:17px;margin-top:22px}h3{font-size:15px}code{background:#f2f5f8;padding:1px 4px;border-radius:3px;font-size:13px}</style>',
    salida.join('\n'),
    '</div>',
  ].join('\n');
}

export function resolveEmailConfig(env = process.env) {
  const apiKey = asText(env.RESEND_API_KEY);
  const from = asText(env.REPORT_EMAIL_FROM) || asText(env.SALES_NOTIFICATION_FROM);
  const to = asText(env.REPORT_EMAIL_TO) || asText(env.SALES_NOTIFICATION_TO);
  const destinatarios = to.split(',').map(uno => asText(uno)).filter(Boolean);

  if (!apiKey) return { ok: false, motivo: 'Falta RESEND_API_KEY.' };
  if (!from) return { ok: false, motivo: 'Falta REPORT_EMAIL_FROM (o SALES_NOTIFICATION_FROM).' };
  if (!destinatarios.length) return { ok: false, motivo: 'Falta REPORT_EMAIL_TO (o SALES_NOTIFICATION_TO).' };

  return { ok: true, apiKey, from, to: destinatarios };
}

export async function sendReportEmail({ subject, markdown, config, fetchFn = globalThis.fetch }) {
  const response = await fetchFn(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.from,
      to: config.to,
      subject,
      text: markdown,
      html: markdownToHtml(markdown),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const detalle = await response.text().catch(() => '');
    return { ok: false, code: `RESEND_HTTP_${response.status}`, detalle: detalle.slice(0, 300) };
  }
  return { ok: true };
}

export async function main() {
  const { readFile } = await import('node:fs/promises');
  const partes = asText(process.env.REPORT_EMAIL_FILES)
    .split(',')
    .map(ruta => asText(ruta))
    .filter(Boolean);

  if (!partes.length) {
    console.error('Nada para mandar: REPORT_EMAIL_FILES está vacío.');
    process.exitCode = 1;
    return;
  }

  const bloques = [];
  for (const ruta of partes) {
    try {
      bloques.push(await readFile(ruta, 'utf8'));
    } catch {
      // Un informe que falta no cancela el correo: justamente el día que algo
      // se rompió es cuando más importa que el mail salga igual, diciendo qué
      // falta en vez de no llegar.
      bloques.push(`_No se generó \`${ruta}\`._\n`);
    }
  }

  const markdown = bloques.join('\n\n---\n\n');
  const config = resolveEmailConfig();
  if (!config.ok) {
    console.error(`No se envía el correo: ${config.motivo}`);
    process.exitCode = 1;
    return;
  }

  const subject = asText(process.env.REPORT_EMAIL_SUBJECT) || 'Amado Libros — informe diario';
  const result = await sendReportEmail({ subject, markdown, config });
  if (!result.ok) {
    console.error(`Resend rechazó el envío: ${result.code} ${result.detalle || ''}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Informe enviado a ${config.to.join(', ')}.`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}
