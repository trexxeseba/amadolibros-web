// Única escritura del guardián en Mercado Libre: dar de baja una publicación de Amado Vintage en revisión por el aviso
// "etiquetas de Mercado Libre en una foto" (decisión de Seba, 21/11/2026: "que el guardián las elimine solo").
// Garantías: solo Amado Vintage (exigirItemDeVintage), nunca una publicación activa, y solo cierra o elimina (nunca activa ni cambia precios).
import {exigirItemDeVintage} from '../../hermes-monitor/guardia.mjs';

export async function eliminarPublicacion(ml, id) {
  const it = await ml.get(`/items/${id}`);
  exigirItemDeVintage(it);
  if (it.status === 'active') return {id, resultado: 'esta_activa_no_se_toca'};
  if (it.status !== 'closed') { try { await ml.put(`/items/${id}`, {status: 'closed'}); } catch { /* en revisión Mercado Libre no deja cerrar: se pide la baja directa */ } }
  await ml.put(`/items/${id}`, {deleted: true});
  const d = await ml.get(`/items/${id}`);
  return {id, resultado: (d.sub_status ?? []).includes('deleted') || d.status === 'closed' ? 'eliminada' : 'no_se_pudo'};
}
