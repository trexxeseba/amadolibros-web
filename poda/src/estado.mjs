// Ciclo de vida de cada anuncio en el registro de la poda (tabla D1 poda_registro).
// Módulo puro: recibe lo leído de Mercado Libre y el registro, devuelve los cambios a
// grabar y las listas del día. La corrida decide si los graba (modo lista) o no
// (modo prueba).
//
// Estados del registro:
//   propuesta_pausa     la poda pidió pausarlo; el Agente único lo pausa en la consola
//   pausado             quedó pausado (lo vio la corrida siguiente). Lo pausó la poda o,
//                       con origen agente_manual, el Agente único antes de la poda
//   propuesta_reactivar la poda pidió reactivarlo (regla 5 o 6)
//   contando            reactivado por la regla 6: el gasto se cuenta desde contar_desde
// Un anuncio pausado que no está en el registro lo pausó otra persona: no se toca.
import { evaluarAnuncio, evaluarReactivacion, aplicarFreno, REGLAS } from './reglas.mjs';

const DIA_MS = 86400000;
export const diasEntre = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DIA_MS);

// Foto del anuncio que se guarda en el registro y se muestra en la lista.
export function foto(g, ev = {}) {
  return {
    ad_group_id: String(g.id), external_id: g.external_id ?? null, tipo: g.tipo ?? null,
    item_ids: g.item_ids ?? [], titulo: g.titulo ?? null,
    campaign_id: g.campaign_id != null ? String(g.campaign_id) : null, campaign_nombre: g.campaign_nombre ?? null,
    precio: g.precio ?? null, precio_lista: ev.precio ?? g.precioTope ?? null, promo: g.promo ? 1 : 0,
    gasto: g.gasto ?? 0, clics: g.clics ?? 0, cpc: ev.cpc ?? g.cpc ?? null,
    tope: ev.tope ?? null, tope_clics: ev.topeClics ?? null,
  };
}

// grupos: Map ad_group_id -> grupo leído (ver run.mjs). registro: filas de D1.
// accion: 'correr' propone pausas y reactivaciones; 'auditar' sólo reactivaciones.
export function calcularDia({ hoy, accion = 'correr', grupos, registro = [], semillas = [] }) {
  const cambios = [];
  const upsert = fila => cambios.push({ tipo: 'upsert', fila: { ...fila, actualizado: hoy } });
  const borrar = (id, motivo) => cambios.push({ tipo: 'borrar', ad_group_id: String(id), motivo });
  const L = { pausar: [], pendientesPausa: [], reactivar: [], observar: [], clicCaro: [], faltaPrecio: [], revisar: [], excedentes: [], pausaria: [], protegidos: [] };
  const reg = new Map(registro.map(r => [String(r.ad_group_id), { ...r }]));

  // Semillas: anuncios que el Agente único pausó a mano antes de la poda.
  for (const s of semillas) {
    if ([...reg.values()].some(r => r.external_id === s.external_id)) continue;
    const g = [...grupos.values()].find(x => x.external_id === s.external_id);
    if (!g || g.estado !== 'PAUSED') continue;
    const fila = { ...foto(g), estado: 'pausado', origen: s.origen ?? 'agente_manual', motivo: s.motivo ?? 'Pausado a mano por el Agente único.', fecha_propuesta: s.fecha_pausa, fecha_pausa: s.fecha_pausa };
    reg.set(String(g.id), fila); upsert(fila);
  }

  const vistos = new Set();
  for (const r of reg.values()) {
    const id = String(r.ad_group_id), g = grupos.get(id);
    if (!g) continue;
    vistos.add(id);
    if (r.estado === 'propuesta_pausa') {
      if (g.estado === 'PAUSED') { upsert({ ...r, estado: 'pausado', fecha_pausa: hoy }); continue; }
      if (g.estado !== 'ACTIVE') { borrar(id, `Quedó en estado ${g.estado}.`); continue; }
      const ev = evaluarAnuncio(g);
      if (ev.accion === 'pausar') { L.pendientesPausa.push({ ...foto(g, ev), motivo: ev.motivo, desde: r.fecha_propuesta }); upsert({ ...r, ...foto(g, ev), motivo: ev.motivo }); }
      else { borrar(id, `Ya no corresponde pausarlo: ${ev.motivo}`); vistos.delete(id); }
      continue;
    }
    if (r.estado === 'pausado') {
      if (g.estado === 'ACTIVE') { borrar(id, 'Lo reactivó otra persona.'); vistos.delete(id); continue; }
      if (g.estado !== 'PAUSED') continue;
      const rv = evaluarReactivacion(r, { ventasAtribuidas: g.ventasAtribuidas, ventasOrdenesDesdePausa: g.ordenesDesde?.(r.fecha_pausa) ?? 0, precioLista: g.precioTope, promo: g.promo });
      if (rv.accion === 'reactivar') {
        const fila = { ...r, estado: 'propuesta_reactivar', regla_reactivar: rv.regla, motivo: rv.motivo, fecha_reactivar_propuesta: hoy };
        upsert(fila); L.reactivar.push({ ...foto(g), motivo: rv.motivo, regla: rv.regla, origen: r.origen });
      }
      continue;
    }
    if (r.estado === 'propuesta_reactivar') {
      if (g.estado === 'ACTIVE') {
        if (Number(r.regla_reactivar) === 6) upsert({ ...r, estado: 'contando', contar_desde: r.fecha_reactivar_propuesta, fecha_reactivada: hoy });
        else borrar(id, 'Reactivado por venta (regla 5).');
        vistos.delete(id);
      } else if (g.estado === 'PAUSED') L.reactivar.push({ ...foto(g), motivo: r.motivo, regla: Number(r.regla_reactivar) || null, origen: r.origen, desde: r.fecha_reactivar_propuesta });
      continue;
    }
    if (r.estado === 'contando') {
      if (r.contar_desde && diasEntre(r.contar_desde, hoy) > REGLAS.diasVentana) borrar(id, 'Pasaron 30 días desde que se volvió a contar.');
      vistos.delete(id); // se evalúa como cualquier activo, con el gasto desde contar_desde
    }
  }

  // Activos que no están ya propuestos: reglas 1 a 4.
  const candidatos = [];
  for (const g of grupos.values()) {
    const id = String(g.id);
    if (vistos.has(id) || g.estado !== 'ACTIVE' || g.salteado) continue;
    const ev = evaluarAnuncio(g);
    const f = { ...foto(g, ev), motivo: ev.motivo };
    if (ev.clicCaro && (g.clics ?? 0) > 0) L.clicCaro.push(f);
    if (ev.accion === 'pausar') candidatos.push(f);
    else if (ev.accion === 'observar') L.observar.push(f);
    else if (ev.accion === 'falta_precio') L.faltaPrecio.push(f);
    else if (ev.accion === 'revisar') L.revisar.push(f);
    else if (ev.accion === 'protegido' && (g.gasto ?? 0) > 0) L.protegidos.push(f);
  }

  let freno = { entran: [], excedentes: [], lugar: 0, alerta: false };
  if (accion === 'correr') {
    const nuevasHoy = registro.filter(r => r.fecha_propuesta === hoy && r.origen === 'poda').length;
    freno = aplicarFreno(candidatos, { nuevasHoy });
    for (const f of freno.entran) {
      const previa = reg.get(f.ad_group_id);
      upsert({ ...(previa ?? {}), ...f, estado: 'propuesta_pausa', origen: 'poda', fecha_propuesta: hoy, contar_desde: previa?.contar_desde ?? null });
      L.pausar.push(f);
    }
    L.excedentes = freno.excedentes;
  } else L.pausaria = candidatos;

  // Transparencia: los que gastaron $150 o más y no se pausan, con el motivo.
  const propuestos = new Set([...L.pausar, ...L.pendientesPausa, ...L.pausaria].map(f => f.ad_group_id));
  L.conGasto = [...grupos.values()].filter(g => (g.gasto ?? 0) >= REGLAS.pisoTope && !propuestos.has(String(g.id))).sort((a, b) => b.gasto - a.gasto).map(g => {
    const motivo = g.estado !== 'ACTIVE' ? `Estado ${g.estado}` : g.protegido ? g.protegido : (g.ventasAtribuidas ?? 0) > 0 ? `Venta atribuida (${g.ventasAtribuidas})` : (g.ventasOrdenes ?? 0) > 0 ? `Venta en órdenes (${g.ventasOrdenes})` : (g.clics ?? 0) < REGLAS.minClics ? `Menos de ${REGLAS.minClics} clics (${g.clics})` : L.excedentes.some(f => f.ad_group_id === String(g.id)) ? 'Excedente del freno' : 'Debajo del tope';
    return { ...foto(g), motivo };
  });

  const contadores = {
    evaluados: [...grupos.values()].filter(g => g.estado === 'ACTIVE' || g.estado === 'PAUSED').length,
    activos: [...grupos.values()].filter(g => g.estado === 'ACTIVE').length,
    pausar: L.pausar.length, pendientes_pausa: L.pendientesPausa.length, reactivar: L.reactivar.length,
    observacion: L.observar.length, clic_caro: L.clicCaro.length, falta_precio: L.faltaPrecio.length,
    revisar: L.revisar.length, excedentes: L.excedentes.length, pausaria: L.pausaria.length, protegidos: L.protegidos.length,
  };
  return { cambios, listas: L, contadores, alertaFreno: freno.alerta };
}
