/**
 * Encabezado y pie comunes de los emails automáticos que le llegan a Seba y al equipo.
 *
 * Regla de Seba (23/11/2026): todo email que mande una tarea o un proceso automático dice
 *   - arriba: de qué APP y PROYECTO salió y su COMETIDO (en mayúscula y negrita);
 *   - abajo: CÓMO DESACTIVARLO O MODIFICARLO.
 *
 * Sin dependencias: lo usan scripts de Node (.mjs), el Worker de Cloudflare y las funciones.
 * Los datos de cada proceso están en PROCESOS. Para sumar un aviso nuevo, agregar su entrada
 * acá (con los datos verificados en el workflow o el Worker) y pasar `proceso: '<id>'`.
 * Solo se escribe en "apagar" y "modificar" lo que existe de verdad en el repo.
 */

const REPO = 'trexxeseba/amadolibros-web';
const ACTIONS = (archivo) => `GitHub > repo ${REPO} > Actions > ${archivo}`;
const DESHABILITAR = (archivo, nombre) =>
  `Apagarlo del todo: ${ACTIONS(`"${nombre}"`)} > menú de los tres puntos > Disable workflow (archivo .github/workflows/${archivo}).`;
const DESTINATARIOS = (variable, donde) =>
  `Cambiar quién lo recibe: la variable ${variable} (${donde}).`;

const APP_WEB = 'Amado Libros Web (amadolibros.com)';

export const PROCESOS = {
  guardian: {
    app: `${APP_WEB}, corre en GitHub Actions y lo lanza el Worker amadolibros-sync`,
    proyecto: 'Amado Vintage: Guardián de las publicaciones',
    cometido: 'VIGILAR CADA 15 MINUTOS QUE LAS PUBLICACIONES DE AMADO VINTAGE ESTÉN ACTIVAS Y AVISAR SI MERCADO LIBRE LAS PAUSA O ALGO SE TRABA',
    apagar: [
      'Apagar el Guardián (y también Hermes): en GitHub > Settings > Secrets and variables > Actions > Variables, poner HERMES_APAGADO = true. Para volver a prenderlo, ponerla en false.',
      DESHABILITAR('guardian.yml', 'Guardián de las publicaciones de Vintage'),
    ],
    modificar: [
      'Frecuencia: la línea cron de .github/workflows/guardian.yml (hoy cada 15 minutos) y los cron del Worker en worker-sync/wrangler.toml.',
      'Qué vigila y qué arregla solo: scripts/guardian/guardian.mjs. Nunca suelta el freno ni toca Amado Libros.',
      DESTINATARIOS('PRECIO_GANADOR_EMAIL_TO', 'en el env del job de guardian.yml'),
    ],
  },
  'vintage-nube': {
    app: `${APP_WEB}, corre en GitHub Actions`,
    proyecto: 'Amado Vintage: publicador en la nube',
    cometido: 'PUBLICAR TANDAS DE AMADO VINTAGE EN MERCADO LIBRE SIN LA PC Y AVISAR SI SE FRENA, FALLA O APARECE UNA DENUNCIA',
    apagar: [
      'Frenar las altas sin apagar nada más: en scripts/vintage-local/campaign.json poner "nube": {"modo": "apagado"} (o "ejecutor": "pc").',
      DESHABILITAR('vintage-nube.yml', 'Vintage publicador (nube)'),
    ],
    modificar: [
      'Tanda, tope diario y minutos: scripts/vintage-local/campaign.json, llave "nube". Detalle en docs/vintage-nube.md.',
      DESTINATARIOS('PRECIO_GANADOR_EMAIL_TO', 'en el env del workflow vintage-nube.yml'),
    ],
  },
  'vintage-parte': {
    app: `${APP_WEB}, corre en GitHub Actions`,
    proyecto: 'Amado Vintage: parte diario',
    cometido: 'RESUMIR CADA DÍA QUÉ PASÓ EN AMADO VINTAGE (ALTAS, VENTAS Y ESTADO)',
    apagar: [DESHABILITAR('vintage-parte.yml', 'Vintage parte corto')],
    modificar: [
      'Horario: la línea cron de .github/workflows/vintage-parte.yml. Contenido: scripts/partes/vintage-parte.mjs.',
      DESTINATARIOS('PRECIO_GANADOR_EMAIL_TO', 'en el env del workflow vintage-parte.yml'),
    ],
  },
  'competencia-ml': {
    app: `${APP_WEB}, corre en GitHub Actions`,
    proyecto: 'Competencia en Mercado Libre: foto semanal del competidor',
    cometido: 'MIRAR QUÉ VENDE EL COMPETIDOR SEGUIDO Y QUÉ HACE EN LOS LIBROS QUE VENDEMOS NOSOTROS, Y AVISAR LOS CAMBIOS',
    apagar: [DESHABILITAR('competencia-catalogo.yml', 'Competencia catálogo (foto semanal)')],
    modificar: [
      'Horario: las líneas cron de .github/workflows/competencia-catalogo.yml (domingo foto completa, lunes a sábado pulso). Detalle en docs/competencia-catalogo.md.',
      DESTINATARIOS('PRECIO_GANADOR_EMAIL_TO', 'en el env del workflow competencia-catalogo.yml'),
    ],
  },
  'aviso-manual': {
    app: `${APP_WEB}, corre en GitHub Actions (disparo manual)`,
    proyecto: 'Aviso por mail mandado a mano',
    cometido: 'ENTREGAR UN AVISO QUE ALGUIEN PIDIÓ MANDAR DESDE EL WORKFLOW "MANDAR UN AVISO POR MAIL"',
    apagar: ['No es automático: solo sale cuando alguien lanza el workflow a mano. Para impedirlo, ' + DESHABILITAR('avisar.yml', 'Mandar un aviso por mail').replace('Apagarlo del todo: ', '')],
    modificar: ['Texto y destinatarios: scripts/avisos/enviar.mjs y .github/workflows/avisar.yml.'],
  },
  poda: {
    app: `${APP_WEB}, corre en GitHub Actions (y lo dispara el Worker amadolibros-sync)`,
    proyecto: 'Mercado Ads: poda de anuncios de Amado Libros',
    cometido: 'DETECTAR LOS ANUNCIOS DE MERCADO ADS QUE GASTAN SIN VENDER PARA PAUSARLOS, Y LOS QUE HAY QUE REACTIVAR POR VENTAS TARDÍAS',
    apagar: [
      'Dejarla en prueba: variable del repo PODA_DRY_RUN = true (consulta y avisa, no decide nada real).',
      'Apagarla: poda/modo.json con "modo": "off".',
      DESHABILITAR('poda-anuncios.yml', 'Poda de anuncios (Mercado Ads)'),
    ],
    modificar: [
      'Reglas y topes: poda/src/reglas.mjs y poda/README.md. Horarios: las líneas cron de poda-anuncios.yml (11:30 y 21:30 de Montevideo).',
      DESTINATARIOS('PODA_EMAIL_TO', 'en el env del workflow poda-anuncios.yml'),
    ],
  },
  'poda-vigia': {
    app: `${APP_WEB}, corre en GitHub Actions`,
    proyecto: 'Mercado Ads: latido de la poda de anuncios',
    cometido: 'COMPROBAR QUE LA PODA DE ANUNCIOS CORRIÓ HOY Y ALARMAR SI NO HAY UNA CORRIDA EXITOSA',
    apagar: [DESHABILITAR('poda-anuncios-vigia.yml', 'Poda de anuncios (latido)')],
    modificar: ['Horario: la línea cron de .github/workflows/poda-anuncios-vigia.yml (13:10 de Montevideo). Código: poda/src/vigia.mjs.'],
  },
  hermes: {
    app: `${APP_WEB}, corre en GitHub Actions`,
    proyecto: 'Amado Vintage: Hermes, chequeo diario',
    cometido: 'REVISAR CADA MAÑANA CÓMO VAN LAS PUBLICACIONES DE HERMES Y ARNOIA EN AMADO VINTAGE',
    apagar: [
      'Apagar Hermes (y el Guardián): en GitHub > Settings > Secrets and variables > Actions > Variables, poner HERMES_APAGADO = true.',
      DESHABILITAR('hermes-chequeo.yml', 'Hermes chequeo diario'),
    ],
    modificar: [
      'Horario: la línea cron de .github/workflows/hermes-chequeo.yml (08:23 de Montevideo). Modo real o prueba: variable HERMES_REAL.',
      DESTINATARIOS('HERMES_EMAIL_TO', 'en el env del workflow hermes-chequeo.yml; si no existe va a adm@amadolibros.com'),
    ],
  },
  'precio-ganador': {
    app: `${APP_WEB}, corre en GitHub Actions (y lo dispara el Worker amadolibros-sync)`,
    proyecto: 'Mercado Libre: Precio Ganador (Amado Libros y Amado Vintage)',
    cometido: 'AJUSTAR LOS PRECIOS PARA GANAR LA FICHA DE CATÁLOGO EN MERCADO LIBRE Y AVISAR LO QUE CAMBIÓ O FALLÓ',
    apagar: [
      'Pausar sin tocar código: variable del repo PRECIO_GANADOR_DRY_RUN = true (consulta y reporta, no cambia ningún precio).',
      'Por cuenta: precio-ganador/modo.json.',
      DESHABILITAR('precio-ganador.yml', 'Precio Ganador'),
    ],
    modificar: [
      'Reglas por cuenta: precio-ganador/src/config.mjs. Horarios: las líneas cron de precio-ganador.yml (cada 2 horas de 09:00 a 21:00 de Montevideo).',
      DESTINATARIOS('PRECIO_GANADOR_EMAIL_TO', 'en el env del workflow precio-ganador.yml'),
      'Controles y alarmas: precio-ganador-control.yml y precio-ganador-vigia.yml.',
    ],
  },
  'precio-ganador-lanzador': {
    app: 'Worker de Cloudflare amadolibros-sync',
    proyecto: 'Mercado Libre: Precio Ganador, lanzador de corridas',
    cometido: 'PEDIRLE A GITHUB QUE CORRA PRECIO GANADOR A SU HORA Y ALARMAR SI NO PUDO HACERLO',
    apagar: [
      'Dejar de lanzar desde el Worker: quitar las horas "0 12/14/16/18/20/22/0 * * *" de crons en worker-sync/wrangler.toml y desplegar. El cron de GitHub queda de respaldo.',
      DESHABILITAR('precio-ganador.yml', 'Precio Ganador'),
    ],
    modificar: [
      'Código: worker-sync/precio-ganador-trigger.js.',
      DESTINATARIOS('PRECIO_GANADOR_EMAIL_TO', 'variable del Worker amadolibros-sync en Cloudflare'),
    ],
  },
  'brujula': {
    app: 'Worker de Cloudflare amadolibros-sync (panel de amadolibros.com)',
    proyecto: 'Panel de Amado Libros: informe diario y Brújula Amado',
    cometido: 'RESUMIR CADA MAÑANA LO QUE HAY QUE DESPACHAR, COBRAR Y MIRAR, Y LOS CLIENTES QUE DEJARON SU WHATSAPP',
    apagar: [
      'Dejar de recibirlo: sacar la dirección de DAILY_DIGEST_TO (informe) y de DAILY_BRUJULA_TO (Brújula, solo el dueño), dos variables de worker-sync/wrangler.toml, y desplegar el Worker amadolibros-sync.',
      'Apagarlo para todos: quitar del Worker los crons "3 11 * * *" y "3 12 * * *" en worker-sync/wrangler.toml y desplegar.',
    ],
    modificar: [
      'Contenido: worker-sync/daily-panel-digest.js. Reglas de reposición y de qué se informa: functions/_shared/panel-bi.js.',
      'Destinatarios: DAILY_DIGEST_TO (informe) y DAILY_BRUJULA_TO (Brújula, solo el dueño), en worker-sync/wrangler.toml.',
    ],
  },
  'informe-web': {
    app: `${APP_WEB}, corre en GitHub Actions`,
    proyecto: 'Amado Libros Web: informe de salud y embudo de checkout',
    cometido: 'REVISAR CADA DÍA LA SALUD DE LA WEB (SINCRONIZACIÓN, REPORTES) Y CÓMO AVANZAN LOS CLIENTES EN EL CHECKOUT',
    apagar: [DESHABILITAR('checkout-funnel-report.yml', 'Informe diario — embudo de checkout y salud de la web')],
    modificar: [
      'Horario: la línea cron de .github/workflows/checkout-funnel-report.yml. Código: scripts/commerce/checkout-funnel-report.mjs.',
      DESTINATARIOS('REPORT_EMAIL_TO', 'o SALES_NOTIFICATION_TO si no existe; en el env del workflow'),
    ],
  },
  'informe-semanal': {
    app: `${APP_WEB}, corre en GitHub Actions`,
    proyecto: 'Amado Libros Web: informe semanal analítico',
    cometido: 'RESUMIR CADA LUNES VENTAS, EMBUDO, PAGOS, DEMANDA SIN ATENDER, SEO Y CATÁLOGO DE LA SEMANA',
    apagar: [DESHABILITAR('weekly-analytics-report.yml', 'Informe semanal analítico')],
    modificar: [
      'Horario: la línea cron de .github/workflows/weekly-analytics-report.yml (lunes 09:05 de Montevideo).',
      DESTINATARIOS('REPORT_EMAIL_TO', 'o SALES_NOTIFICATION_TO si no existe; en el env del workflow'),
    ],
  },
  busquedas: {
    app: `${APP_WEB}, corre en GitHub Actions (disparo manual)`,
    proyecto: 'Amado Libros Web: lo que pidieron clientes reales',
    cometido: 'LISTAR LAS BÚSQUEDAS DE CLIENTES QUE NO ENCONTRARON UN LIBRO EN EL SITIO',
    apagar: [DESHABILITAR('busquedas-export.yml', 'Lo que pidieron clientes reales, listado por correo (solo lectura)')],
    modificar: [DESTINATARIOS('REPORT_EMAIL_TO', 'o SALES_NOTIFICATION_TO si no existe; en el env del workflow busquedas-export.yml')],
  },
  premio: {
    app: `${APP_WEB}, función de la web en Cloudflare Pages`,
    proyecto: 'Amado Libros Web: Rueda del Librero y Acertijo',
    cometido: 'AVISAR CADA VEZ QUE ALGUIEN GANA UN PREMIO O LO CANJEA POR WHATSAPP',
    apagar: ['Dejar de recibir estos avisos: sacar tu dirección de SALES_NOTIFICATION_TO (variable de Cloudflare Pages del proyecto amadolibros-web). Ojo: esa misma variable recibe el aviso de ventas de la web.'],
    modificar: ['Código: functions/_shared/premio-avisos.js. Destinatarios y remitente: SALES_NOTIFICATION_TO y SALES_NOTIFICATION_FROM.'],
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function datos(proceso) {
  const p = typeof proceso === 'string' ? PROCESOS[proceso] : proceso;
  if (!p) throw new Error(`email-encabezado: proceso desconocido "${proceso}"`);
  return p;
}

/** Texto plano del encabezado. En texto plano no hay negrita: el COMETIDO va en mayúscula. */
export function encabezadoTexto(proceso) {
  const p = datos(proceso);
  return `APP: ${p.app}\nPROYECTO: ${p.proyecto}\nCOMETIDO: ${p.cometido}\n${'-'.repeat(40)}\n`;
}

/** Texto plano del pie con cómo desactivar y modificar. */
export function pieTexto(proceso) {
  const p = datos(proceso);
  const lista = (xs) => xs.map((x) => `  - ${x}`).join('\n');
  return `\n${'-'.repeat(40)}\nCÓMO DESACTIVARLO O MODIFICARLO\nDesactivarlo:\n${lista(p.apagar)}\nModificarlo:\n${lista(p.modificar)}\n`;
}

/** Bloque HTML del encabezado: COMETIDO en mayúscula y negrita. */
export function encabezadoHtml(proceso) {
  const p = datos(proceso);
  return `<div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.5;color:#333;background:#f6f1ea;border-left:4px solid #a94e3d;padding:10px 14px;margin:0 0 18px">`
    + `<div><b>APP:</b> ${esc(p.app)}</div>`
    + `<div><b>PROYECTO:</b> ${esc(p.proyecto)}</div>`
    + `<div style="margin-top:6px"><b>COMETIDO: ${esc(p.cometido)}</b></div>`
    + `</div>`;
}

/** Bloque HTML del pie. */
export function pieHtml(proceso) {
  const p = datos(proceso);
  const ul = (xs) => `<ul style="margin:4px 0 8px 18px;padding:0">${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  return `<div style="font-family:Arial,sans-serif;font-size:12px;line-height:1.5;color:#444;border-top:1px solid #d9cfc2;margin-top:24px;padding-top:12px">`
    + `<div><b>CÓMO DESACTIVARLO O MODIFICARLO</b></div>`
    + `<div>Desactivarlo:</div>${ul(p.apagar)}`
    + `<div>Modificarlo:</div>${ul(p.modificar)}`
    + `</div>`;
}

/** Texto plano convertido a HTML simple (para los avisos que solo traían texto). */
export function textoAHtml(texto) {
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${esc(texto)}</div>`;
}

/**
 * Envuelve un mail: devuelve { text, html } con encabezado y pie.
 * `html` es opcional; si falta se arma a partir del texto.
 */
export function envolverMail({ proceso, texto = '', html = null }) {
  const cuerpoHtml = html ?? textoAHtml(texto);
  const text = `${encabezadoTexto(proceso)}\n${texto}${pieTexto(proceso)}`;
  // Si el HTML ya es un documento completo, el encabezado y el pie van adentro del <body>.
  const abre = /<body[^>]*>/i.exec(cuerpoHtml);
  const cierra = cuerpoHtml.toLowerCase().lastIndexOf('</body>');
  if (abre && cierra > abre.index) {
    const finAbre = abre.index + abre[0].length;
    return { text, html: `${cuerpoHtml.slice(0, finAbre)}${encabezadoHtml(proceso)}${cuerpoHtml.slice(finAbre, cierra)}${pieHtml(proceso)}${cuerpoHtml.slice(cierra)}` };
  }
  return { text, html: `<div>${encabezadoHtml(proceso)}${cuerpoHtml}${pieHtml(proceso)}</div>` };
}
