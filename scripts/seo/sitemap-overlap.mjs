/**
 * Los sitemaps «activo» y «por encargo» se generan al momento de pedirlos, uno
 * después del otro. Si un libro cambia de estado justo en el medio (se agota,
 * vuelve el stock, el sync publica) puede aparecer en los dos un instante. Eso
 * no es un error del reporte: abortar toda la extracción de Search Console por
 * una URL dejaba al informe semanal sin datos.
 *
 * Regla: una superposición chica se tolera y queda registrada; una grande sí
 * frena la corrida, porque ahí algo se rompió de verdad. Las URL superpuestas
 * cuentan como activas (si se vende, se vende).
 */
export const MAX_OVERLAP_ABSOLUTE = 5;
export const MAX_OVERLAP_RATIO = 0.01;

export function reconcileSitemapCohorts(activeUrls, pausedUrls) {
  const activeSet = new Set(activeUrls);
  const overlap = pausedUrls.filter((page) => activeSet.has(page));
  const limit = Math.max(MAX_OVERLAP_ABSOLUTE, Math.floor(Math.min(activeUrls.length, pausedUrls.length) * MAX_OVERLAP_RATIO));
  if (overlap.length > limit) {
    throw new Error(`Los sitemaps activo y por encargo se superponen en ${overlap.length} URLs (máximo tolerado: ${limit}).`);
  }
  const overlapSet = new Set(overlap);
  return {
    activeUrls,
    pausedUrls: pausedUrls.filter((page) => !overlapSet.has(page)),
    overlap,
  };
}
