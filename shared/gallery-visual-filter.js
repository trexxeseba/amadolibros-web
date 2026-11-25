/** Fail open on unavailable images/CORS/canvas. Only reviewed matches are removed.
 * Bounded concurrency and thumbnail pixels keep the work away from checkout.
 * Serializable so the product page can use the same controller in the browser.
 */
export async function excludeNonBookImages(images, policy, onExclude, dom = globalThis) {
  let cursor = 0;
  async function inspect(image) {
    return new Promise(resolve => {
      const preview = new dom.Image();
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        dom.clearTimeout(timeout);
        preview.onload = preview.onerror = null;
        resolve(result);
      };
      const timeout = dom.setTimeout(() => finish(null), 4000);
      preview.crossOrigin = 'anonymous';
      preview.onload = () => {
        try {
          const canvas = dom.document.createElement('canvas');
          canvas.width = canvas.height = 32;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, 32, 32);
          ctx.drawImage(preview, 0, 0, 32, 32);
          const fp = policy.fingerprint(ctx.getImageData(0, 0, 32, 32).data,
            preview.naturalWidth / preview.naturalHeight);
          finish(policy.match(fp));
        } catch { finish(null); }
      };
      preview.onerror = () => finish(null);
      preview.src = image.thumb;
    });
  }
  async function worker() {
    while (cursor < images.length) {
      const index = cursor++;
      try { if (await inspect(images[index])) onExclude(index); } catch { /* Preserve unclassified images. */ }
    }
  }
  await Promise.all([worker(), worker()]);
}
