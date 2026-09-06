// Exact source replacements, visually checked against the same ML image.
// Evidence: GitHub Actions 34026064103, artifact 9987082757.
// No positional reordering: existing cover URLs retain their image identity.
export const VERIFIED_COVER_SOURCES = Object.freeze([
  {
    "product_id": "MLU636119126",
    "source_url": "https://http2.mlstatic.com/D_702959-MLA51374865484_092022-O.jpg",
    "replacement_url": "https://http2.mlstatic.com/D_NQ_NP_702959-MLA51374865484_092022-F.jpg",
    "width": 809,
    "height": 1200,
    "evidence_run": 34026064103,
    "visual_verified_at": "2026-09-06"
  },
  {
    "product_id": "MLU629952475",
    "source_url": "https://http2.mlstatic.com/D_718805-MLA44453120424_122020-O.jpg",
    "replacement_url": "https://http2.mlstatic.com/D_NQ_NP_718805-MLA44453120424_122020-F.jpg",
    "width": 960,
    "height": 1200,
    "evidence_run": 34026064103,
    "visual_verified_at": "2026-09-06"
  },
  {
    "product_id": "MLU629952475",
    "source_url": "https://http2.mlstatic.com/D_799030-MLA44584988632_012021-O.jpg",
    "replacement_url": "https://http2.mlstatic.com/D_NQ_NP_799030-MLA44584988632_012021-F.jpg",
    "width": 871,
    "height": 1200,
    "evidence_run": 34026064103,
    "visual_verified_at": "2026-09-06"
  },
  {
    "product_id": "MLU670646778",
    "source_url": "https://http2.mlstatic.com/D_664612-MLU74204550452_012024-O.jpg",
    "replacement_url": "https://http2.mlstatic.com/D_NQ_NP_664612-MLU74204550452_012024-F.jpg",
    "width": 1066,
    "height": 1198,
    "evidence_run": 34026064103,
    "visual_verified_at": "2026-09-06"
  },
  {
    "product_id": "MLU643205029",
    "source_url": "https://http2.mlstatic.com/D_726512-MLA43347675473_092020-O.jpg",
    "replacement_url": "https://http2.mlstatic.com/D_NQ_NP_726512-MLA43347675473_092020-F.jpg",
    "width": 759,
    "height": 1200,
    "evidence_run": 34026064103,
    "visual_verified_at": "2026-09-06"
  }
].map(Object.freeze));

export function verifiedCoverSource(productId, source) {
  if (typeof source !== 'string') return source;
  let normalized;
  try {
    const url = new URL(source);
    url.protocol = 'https:';
    url.hash = '';
    url.pathname = url.pathname.replace(/-I\.(jpg|jpeg|png|webp)$/i, '-O.$1');
    normalized = url.toString();
  } catch { return source; }
  return VERIFIED_COVER_SOURCES.find(row =>
    row.product_id === String(productId || '').toUpperCase() && row.source_url === normalized
  )?.replacement_url || source;
}

export function verifiedNativeCover(productId, source) {
  return VERIFIED_COVER_SOURCES.find(row =>
    row.product_id === String(productId || '').toUpperCase() && row.replacement_url === source
  ) || null;
}
