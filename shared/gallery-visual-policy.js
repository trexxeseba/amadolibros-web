/** Conservative comparison against visually reviewed non-book images.
 * A match needs the same proportions, similar layout and similar colors.
 * Unknown images are preserved; this never classifies book content by topic.
 * This factory is shared by the browser and offline regression fixtures.
 */
export function createGalleryVisualPolicy(references = []) {
  const size = 32, cells = 4;
  const cos = Array.from({ length: size }, (_, x) =>
    Array.from({ length: 8 }, (_, k) => Math.cos((2 * x + 1) * k * Math.PI / (2 * size))));
  const bitCounts = [0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4];

  function fingerprint(rgba, aspect) {
    if (!rgba || rgba.length !== size * size * 4 || !Number.isFinite(aspect) || aspect <= 0) return null;
    const gray = [], colors = Array(cells * cells * 3).fill(0);
    let sum = 0, square = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4, alpha = rgba[i + 3] / 255;
      const rgb = [0,1,2].map(c => rgba[i + c] * alpha + 255 * (1 - alpha));
      const value = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      gray.push(value); sum += value; square += value * value;
      const cell = (Math.floor(y / 8) * cells + Math.floor(x / 8)) * 3;
      for (let c = 0; c < 3; c++) colors[cell + c] += rgb[c] / 64;
    }
    const coefficients = [];
    for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
      let value = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) value += gray[y * size + x] * cos[x][u] * cos[y][v];
      coefficients.push(value);
    }
    const median = coefficients.slice(1).sort((a,b) => a-b)[31];
    const bits = coefficients.map((v,i) => i && v > median ? '1' : '0').join('');
    let hash = '';
    for (let i = 0; i < 64; i += 4) hash += parseInt(bits.slice(i,i+4),2).toString(16);
    return { hash, aspect: Math.round(aspect * 10000) / 10000,
      colors: colors.map(Math.round), contrast: Math.sqrt(Math.max(0,square / 1024 - (sum / 1024) ** 2)) };
  }

  function distance(a,b) {
    if (!/^[0-9a-f]{16}$/.test(a || '') || !/^[0-9a-f]{16}$/.test(b || '')) return 64;
    let count = 0;
    for (let i=0;i<16;i++) count += bitCounts[parseInt(a[i],16) ^ parseInt(b[i],16)];
    return count;
  }

  function match(candidate) {
    if (!candidate || candidate.contrast < 8 || !Array.isArray(candidate.colors) || candidate.colors.length !== 48) return null;
    for (const ref of references) {
      if (!ref || !Array.isArray(ref.colors) || ref.colors.length !== 48 || ref.contrast < 8) continue;
      if (Math.abs(Math.log(candidate.aspect / ref.aspect)) > 0.06 || distance(candidate.hash,ref.hash) > 6) continue;
      const colorError = Math.sqrt(candidate.colors.reduce((sum,value,i) => sum + (value-ref.colors[i]) ** 2,0) / 48);
      if (colorError <= 16) return ref.id;
    }
    return null;
  }
  return { fingerprint, match, distance };
}
