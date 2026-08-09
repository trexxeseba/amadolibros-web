import { urlsetXml, xmlResponse } from './_shared/sitemap.js';

/**
 * Segmento reservado para la futura cohorte indexable de pausados.
 * Permanece vacío y NO figura en sitemap.xml hasta que exista una cohorte
 * explícitamente aprobada. Mantener el endpoint permite habilitarla sin
 * cambiar el contrato de URLs de sitemap más adelante.
 */
export async function onRequest() {
  return xmlResponse(urlsetXml([]));
}
