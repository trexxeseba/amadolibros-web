// Guardián de las publicaciones de Amado Vintage (Hermes, Arnoia y SBS).
//
// Hace dos trabajos, cada 15 minutos:
//  1. DETECTA lo que puede salir mal ANTES de que se note: tandas que no corren a su hora, corridas caídas,
//     publicaciones que Mercado Libre pausó, fotos que no terminan de cargar, el freno del vigía puesto.
//  2. ARREGLA solo lo que se puede arreglar sin riesgo (lista cerrada abajo) y AVISA por mail en lenguaje
//     simple: qué pasó, qué hizo, y si hace falta que decidas, con 3 opciones.
//
// Lo que puede hacer solo (nada más):
//   - pedir de nuevo una tanda de Hermes/Arnoia o de SBS que no corrió;
//   - reintentar UNA vez una corrida fallida de la tanda o del despliegue del Worker;
//   - cancelar una tanda colgada (más de 40 minutos en curso), para que no frene a las siguientes.
// Lo que NUNCA hace: soltar el freno del vigía, reactivar publicaciones, cambiar precios, borrar, ni tocar
// Amado Libros. Todo lo demás lo avisa.
//
//   node scripts/guardian/guardian.mjs [--seco]     (--seco: solo muestra qué haría, no toca ni manda nada)
import fs from 'node:fs/promises';
import {d1Client} from '../vintage-cloud/d1.mjs';
import {brakeOn} from '../vintage-cloud/vigia-pi.mjs';
import {sendMail, uyDayStart} from '../vintage-cloud/aviso.mjs';
import {CUENTAS} from '../../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../../precio-ganador/src/token.mjs';
import {crearCliente} from '../../precio-ganador/src/ml.mjs';
import {CUENTA_HERMES, TOPE_DIARIO_COMPARTIDO, inicioDiaUy} from '../../hermes-monitor/lib.mjs';

export const REPO = process.env.GITHUB_REPOSITORY || 'trexxeseba/amadolibros-web';
export const UMBRALES = {arnoiaMin: 100, sbsMin: 130, fallosSbsSeguidos: 3, fotosMin: 180, cupoMin: 50, ventanaFallosMin: 120};
export const THROTTLE = {aviso: 3 * 3600e3, grave: 3600e3};
const WF_PUBLICAR = 'hermes-publicar.yml', WF_SBS = 'vintage-nube.yml', WF_DEPLOY = 'deploy-worker-sync.yml';
const minutos = (a, b) => Math.round((a - b) / 60000);
export const COLGADA_MIN = 40;
// "En curso" cuenta solo si es reciente: una corrida de más de 40 minutos está colgada y no debe tapar los demás avisos.
const activa = (runs, w, ahora = Date.now()) => (runs?.[w] ?? []).some(r => (r.status === 'in_progress' || r.status === 'queued') && minutos(ahora, Date.parse(r.created_at)) <= COLGADA_MIN);

// ---- Cómo se cuenta cada publicación en el informe ----
export function describirFiltro(nombre) {
  const n = String(nombre ?? '');
  if (/MELI_LABEL/.test(n)) return 'etiquetas de Mercado Libre en una foto';
  if (/DATOS_PERSONALES/.test(n)) return 'datos de contacto o identificación en una foto';
  if (/^OCR_/.test(n)) return 'texto no permitido en una foto';
  return n || 'sin dato';
}
export function describirEstado(status, sub) {
  const s = String(sub ?? '');
  if (status === 'under_review') return 'en revisión: Mercado Libre espera que se corrija algo para activarla';
  if (status === 'paused') return 'pausada';
  if (status === 'closed') return 'cerrada';
  if (status === 'inactive') return 'inactiva';
  return `${status}${s ? ' / ' + s : ''}`;
}
export function bloqueDeItem(i) {
  const quien = [i.autor, i.editorial].filter(Boolean).join(' · ');
  const origen = i.fuente === 'arnoia' ? `de Arnoia, ${i.tradicional ? 'como publicación normal' : 'en ficha de catálogo'}` : i.fuente === 'hermes' ? 'de Hermes' : '';
  const L = [`• «${i.titulo ?? i.id}»${quien ? ` (${quien})` : ''}`, `  Publicación ${i.id}${origen ? ', ' + origen : ''}.`, `  Estado: ${describirEstado(i.status, i.sub_status)}; no la ve ningún comprador.`];
  if (i.moderacion) {
    L.push(`  Motivo que da Mercado Libre: ${i.moderacion.motivo ?? 'sin texto'} (filtro: ${describirFiltro(i.moderacion.filtro)}).`);
    if (i.moderacion.remedio) L.push(`  Qué pide Mercado Libre: ${i.moderacion.remedio}`);
  }
  if (i.tapa) L.push(`  Qué se hizo con la foto: ${i.tapa}.`);
  L.push('  Qué hice yo: nada todavía; solo te aviso. No afecta la cuenta mientras esté así.');
  return L;
}

// ---- Detectar (puro: recibe los datos, no toca la red) ----
// datos: {runs:{wf:[{id,status,conclusion,created_at,run_attempt,html_url}]}, publicadas, freno, cupo,
//         restantesArnoia, items:[{id,status,sub_status,edadMin,titulo,autor,editorial,fuente,tradicional,tapa,moderacion}], muestra}
export function evaluar(d, ahora = Date.now()) {
  const h = [];
  const runs = d.runs ?? {};

  if (d.freno) h.push({
    clave: 'freno_activo', nivel: 'grave',
    texto: 'El vigía de propiedad intelectual puso el freno: no se está publicando nada nuevo hasta que lo revises.',
    opciones: ['Revisar la denuncia que lo disparó y, si es seguro, pedirme que suelte el freno.', 'Dejarlo puesto un día más y mirar de nuevo mañana.', 'Pedirme que pause las publicaciones parecidas a la denunciada.'],
  });

  // Arnoia: hay cupo, hay libros pendientes y no se creó nada hace mucho
  const arn = Object.values(d.publicadas ?? {}).filter(p => p.fuente === 'arnoia' && p.item_id && p.ts);
  const ultimaArn = arn.length ? Math.max(...arn.map(p => Number(p.ts))) : 0;
  const sinArn = minutos(ahora, ultimaArn);
  if (!d.freno && d.restantesArnoia > 0 && d.cupo >= UMBRALES.cupoMin && !activa(runs, WF_PUBLICAR, ahora) && sinArn > UMBRALES.arnoiaMin) h.push({
    clave: 'arnoia_atrasada', nivel: 'aviso',
    texto: `Arnoia no creó ninguna publicación hace ${sinArn >= 100000 ? 'mucho' : sinArn + ' minutos'}, y hay cupo (${d.cupo}) y ${d.restantesArnoia} libros pendientes.`,
    accion: {tipo: 'dispatch', workflow: WF_PUBLICAR, inputs: {modo: 'publicar', cantidad: '50', rama: 'main', fuente: 'arnoia', tradicional: 'false'}, resumen: 'pedí una tanda de Arnoia ahora mismo'},
  });

  // Tanda colgada: lleva más de 40 minutos en curso (una normal tarda unos 5). Se cancela, para que no frene a las siguientes.
  for (const w of [WF_PUBLICAR, WF_SBS]) for (const r of runs[w] ?? []) {
    if (r.status !== 'in_progress' || minutos(ahora, Date.parse(r.created_at)) <= COLGADA_MIN) continue;
    h.push({clave: `colgada_${r.id}`, nivel: 'aviso', texto: `Una corrida lleva ${minutos(ahora, Date.parse(r.created_at))} minutos en curso (normalmente tarda unos 5): ${r.html_url ?? r.id}.`, accion: {tipo: 'cancel', runId: r.id, resumen: 'la cancelé para que no frene a las siguientes'}});
  }

  // Corridas caídas de la tanda y del despliegue del Worker: se reintenta UNA vez; si falla de nuevo, es grave
  for (const w of [WF_PUBLICAR, WF_DEPLOY]) for (const r of runs[w] ?? []) {
    if (r.conclusion !== 'failure' || minutos(ahora, Date.parse(r.created_at)) > UMBRALES.ventanaFallosMin) continue;
    const que = w === WF_DEPLOY ? 'el despliegue del Worker de Cloudflare' : 'una tanda de publicación';
    if ((r.run_attempt ?? 1) === 1) h.push({clave: `fallo_${r.id}`, nivel: 'aviso', texto: `Falló ${que} (${r.html_url ?? r.id}).`, accion: {tipo: 'rerun', runId: r.id, resumen: 'la reintenté una vez'}});
    else h.push({
      clave: `fallo_repetido_${r.id}`, nivel: 'grave', texto: `Falló dos veces ${que} (${r.html_url ?? r.id}).`,
      opciones: ['Dejar que la próxima corrida programada lo intente sola.', 'Pedirme que revise el motivo en el detalle y lo arregle.', 'Frenar las tandas con la variable HERMES_APAGADO hasta entender qué pasa.'],
    });
  }

  // SBS: sin corridas buenas hace rato, o varias fallas seguidas (el portal de SBS se cae a veces)
  const sbs = runs[WF_SBS] ?? [];
  const ultimaBuena = sbs.find(r => r.conclusion === 'success');
  const sinSbs = ultimaBuena ? minutos(ahora, Date.parse(ultimaBuena.created_at)) : Infinity;
  if (sbs.length && sinSbs > UMBRALES.sbsMin && !activa(runs, WF_SBS, ahora) && !d.freno) h.push({
    clave: 'sbs_atrasado', nivel: 'aviso', texto: `La subida de SBS no corre bien hace ${Number.isFinite(sinSbs) ? sinSbs + ' minutos' : 'mucho tiempo'}.`,
    accion: {tipo: 'dispatch', workflow: WF_SBS, inputs: {accion: 'auto'}, resumen: 'pedí una corrida de SBS ahora mismo'},
  });
  let seguidas = 0; for (const r of sbs) { if (r.conclusion === 'failure') seguidas++; else if (r.conclusion === 'success') break; }
  if (seguidas >= UMBRALES.fallosSbsSeguidos) h.push({
    clave: 'sbs_fallando', nivel: 'grave', texto: `La subida de SBS falló ${seguidas} veces seguidas (suele ser el portal de SBS, que corta la descarga).`,
    opciones: ['Esperar: el portal suele volver solo y se reintenta cada hora.', 'Pedirme que revise el detalle de la falla.', 'Escribirle a SBS por el corte del portal.'],
  });

  // Publicaciones que Mercado Libre pausó o cerró: el informe cuenta de cada una qué libro es, el motivo exacto y qué se hizo.
  const pausadas = (d.items ?? []).filter(i => i.status !== 'active' && !String(i.sub_status).includes('deleted') && !(i.status === 'paused' && String(i.sub_status).includes('picture_download_pending')));
  if (pausadas.length) {
    const deFotos = pausadas.every(i => String(i.moderacion?.filtro ?? '').startsWith('OCR_'));
    const unico = pausadas.length === 1 ? pausadas[0] : null;
    h.push({
      clave: 'pausadas_ml_' + pausadas.map(i => i.id).sort().join('-').slice(0, 120), nivel: 'grave',
      asunto: unico ? `«${unico.titulo ?? unico.id}» quedó en revisión en Mercado Libre` : `${pausadas.length} publicaciones quedaron en revisión en Mercado Libre`,
      texto: [`Mercado Libre dejó ${pausadas.length} de las últimas ${d.muestra ?? (d.items ?? []).length} publicaciones sin estar activas.`,
        deFotos ? 'Es el control automático de fotos: no es una denuncia ni un tema de propiedad intelectual.' : 'Hay que mirar el motivo de cada una: algunas pueden ser una denuncia.', '',
        ...pausadas.flatMap(i => bloqueDeItem(i)), ''].join('\n').trimEnd(),
      opciones: deFotos
        ? ['Pasarle estas publicaciones a Lola y Gaby para que pidan la revisión por el chat de Mercado Libre (el texto ya está armado).', 'Eliminarlas, que es lo que Seba autorizó cuando se complica, y volver a publicarlas más adelante.', 'Pedirme que revise si otros libros de la misma editorial o serie van a tener el mismo problema, para saltarlos.']
        : ['Mirarlas una por una en el panel de Mercado Libre para ver el motivo.', 'Pedirme que busque el motivo de cada una y te lo resuma.', 'Frenar las tandas hasta entender si es una denuncia.'],
    });
  }
  const fotos = (d.items ?? []).filter(i => i.status === 'paused' && String(i.sub_status).includes('picture_download_pending') && i.edadMin > UMBRALES.fotosMin);
  if (fotos.length) h.push({
    clave: 'fotos_trabadas', nivel: 'aviso',
    texto: `${fotos.length} publicaciones siguen pausadas esperando las fotos hace más de ${UMBRALES.fotosMin / 60} horas (${fotos.slice(0, 5).map(i => i.id).join(', ')}).`,
    opciones: ['Esperar un rato más: suele resolverse solo.', 'Pedirme que revise si la imagen de tapa de esos libros sigue disponible.', 'Pedirme que pause esas tandas.'],
  });

  return h;
}

// ---- Qué avisar ahora (sin repetir lo ya avisado) ----
export function pendientes(hallazgos, yaAvisado, ahora = Date.now()) {
  return hallazgos.filter(x => {
    const ultimo = yaAvisado.get(x.clave) ?? 0;
    return ahora - ultimo >= THROTTLE[x.nivel === 'grave' ? 'grave' : 'aviso'];
  });
}

export function armarMail(hechos, ahora = Date.now()) {
  const graves = hechos.filter(h => h.nivel === 'grave');
  const L = [];
  L.push(graves.length ? 'Hay algo que necesito que mires.' : 'Encontré algo y ya me ocupé. No tenés que hacer nada.', '');
  for (const h of hechos) {
    L.push(h.texto.includes('\n') ? h.texto : `- ${h.texto}`);
    if (h.resultado) L.push(`  Qué hice: ${h.resultado}`);
    if (h.opciones) { L.push('  Qué podemos hacer:'); h.opciones.forEach((o, i) => L.push(`    ${i + 1}. ${o}`)); L.push('  Mi recomendación es la 1.'); }
    L.push('');
  }
  L.push('Este aviso lo manda el guardián, que mira todo cada 15 minutos.');
  return L.join('\n');
}

// ---- Arreglar (solo la lista cerrada) ----
export async function ejecutar(hallazgos, {dispatch, rerun, cancel = async () => {}, seco = false}) {
  const hechos = [];
  for (const h of hallazgos) {
    const x = {...h};
    if (h.accion && !seco) {
      try {
        if (h.accion.tipo === 'dispatch') await dispatch(h.accion.workflow, h.accion.inputs);
        else if (h.accion.tipo === 'rerun') await rerun(h.accion.runId);
        else if (h.accion.tipo === 'cancel') await cancel(h.accion.runId);
        x.resultado = h.accion.resumen;
      } catch (e) {
        x.resultado = `intenté arreglarlo y no pude (${e.message}); queda para que lo veas`;
        x.nivel = 'grave';
        x.opciones = x.opciones ?? ['Pedirme que lo revise ahora.', 'Esperar a la próxima corrida programada.', 'Frenar las tandas con HERMES_APAGADO.'];
      }
    } else if (h.accion && seco) x.resultado = `(seco) ${h.accion.resumen}`;
    hechos.push(x);
  }
  return hechos;
}

// ---- Reunir datos (red) ----
async function gh(path, {method = 'GET', body, raw = false} = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method, signal: AbortSignal.timeout(25000),
    headers: {Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? {'Content-Type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  if (!res.ok && res.status !== 204 && res.status !== 201) throw new Error(`github_http_${res.status}`);
  return raw ? res.text() : (res.status === 204 || res.status === 201 ? null : res.json());
}

export async function reunir() {
  const query = d1Client();
  const runs = {};
  for (const w of [WF_PUBLICAR, WF_SBS, WF_DEPLOY]) {
    const j = await gh(`/actions/workflows/${w}/runs?per_page=20`).catch(() => ({workflow_runs: []}));
    runs[w] = (j.workflow_runs ?? []).map(r => ({id: r.id, status: r.status, conclusion: r.conclusion, created_at: r.created_at, run_attempt: r.run_attempt, html_url: r.html_url}));
  }
  const publicadas = JSON.parse(await gh('/contents/publicadas-vintage.json?ref=hermes-datos', {raw: true}).catch(() => '{}'));
  const lista = JSON.parse(await fs.readFile(new URL('../../hermes-monitor/data/arnoia-catalogo-19-11.json', import.meta.url), 'utf8'));
  const restantesArnoia = lista.libros.filter(l => !publicadas['arnoia:' + l.ean]).length;
  const freno = await brakeOn(query).catch(() => null);
  const inicio = inicioDiaUy();
  const sbs = Number((await query("SELECT COUNT(*) n FROM ml_vintage_pub_receipts WHERE seller_id=? AND state='published' AND created_at>=?", [CUENTAS[CUENTA_HERMES].sellerId, inicio]).catch(() => [{n: 0}]))[0]?.n ?? 0);
  const hoyHA = Object.values(publicadas).filter(p => p.item_id && Number(p.ts) >= inicio).length;
  const cupo = Math.max(0, TOPE_DIARIO_COMPARTIDO - sbs - hoyHA);
  // Muestra de las últimas 40 publicaciones creadas, leídas de Mercado Libre (solo lectura). De las que no están activas se lee también el motivo.
  const ml = crearCliente(fuenteTokenD1(CUENTAS[CUENTA_HERMES]), {concurrencia: 1});
  const recientes = Object.entries(publicadas).filter(([, p]) => p.item_id && p.ts).sort((a, b) => b[1].ts - a[1].ts).slice(0, 40);
  const items = [];
  for (const [clave, p] of recientes) {
    const it = await ml.get(`/items/${p.item_id}`).catch(() => null);
    if (it) {
      const atr = id => (it.attributes ?? []).find(a => a.id === id)?.value_name;
      const sub = (it.sub_status ?? []).join(',');
      const item = {id: it.id, status: it.status, sub_status: sub, edadMin: minutos(Date.now(), Number(p.ts)), titulo: atr('BOOK_TITLE') ?? it.title ?? it.family_name, autor: atr('AUTHOR'), editorial: atr('BOOK_PUBLISHER'), fuente: p.fuente, tradicional: Boolean(p.tradicional),
        tapa: p.fuente === 'hermes' || !p.tradicional ? 'ficha de catálogo: usa las fotos oficiales de Mercado Libre' : p.portada_limpiada ? `se usó la tapa de la librería, con un borrado previo (${p.portada_limpiada})` : 'se usó la tapa de la librería original, sin borrar nada'};
      if (it.status !== 'active' && !(it.status === 'paused' && sub.includes('picture_download_pending'))) {
        await new Promise(r => setTimeout(r, 400));
        const m = (await ml.get(`/moderations/last_moderation/${it.id}-ITM`).catch(() => null));
        const u = Array.isArray(m) ? m[0] : null;
        if (u) item.moderacion = {filtro: u.name, motivo: (u.wordings ?? []).find(w => w.type === 'REASON')?.value, remedio: (u.wordings ?? []).find(w => w.type === 'REMEDY')?.value};
      }
      items.push(item);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return {runs, publicadas, freno, cupo, restantesArnoia, items, muestra: recientes.length, query};
}

async function main() {
  const seco = process.argv.includes('--seco');
  const d = await reunir();
  const query = d.query;
  await query('CREATE TABLE IF NOT EXISTS hermes_guardian_alertas (clave TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  const yaAvisado = new Map((await query('SELECT clave, at FROM hermes_guardian_alertas')).map(r => [r.clave, Number(r.at)]));
  const nuevos = pendientes(evaluar(d), yaAvisado);
  console.log(JSON.stringify({cupo: d.cupo, restantesArnoia: d.restantesArnoia, freno: Boolean(d.freno), hallazgos: nuevos.map(x => x.clave)}));
  if (!nuevos.length) return;
  const hechos = await ejecutar(nuevos, {seco,
    dispatch: (workflow, inputs) => gh(`/actions/workflows/${workflow}/dispatches`, {method: 'POST', body: {ref: 'main', inputs}}),
    rerun: runId => gh(`/actions/runs/${runId}/rerun-failed-jobs`, {method: 'POST'}),
    cancel: runId => gh(`/actions/runs/${runId}/cancel`, {method: 'POST'}),
  });
  console.log(armarMail(hechos));
  if (seco) return;
  const ahora = Date.now();
  for (const h of hechos) await query('INSERT OR REPLACE INTO hermes_guardian_alertas (clave, at) VALUES (?, ?)', [h.clave, ahora]);
  const hayGrave = hechos.some(h => h.nivel === 'grave');
  await sendMail({asunto: hechos.find(h => h.asunto)?.asunto ?? (hayGrave ? 'necesito que mires algo' : 'encontré algo y ya lo arreglé'), texto: armarMail(hechos), prefijo: 'Guardián'});
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error('fallo del guardián', e.message); process.exit(1); });
