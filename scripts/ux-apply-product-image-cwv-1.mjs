import { readFile, writeFile } from 'node:fs/promises';

const path = 'functions/libro/[[path]].js';
let source = await readFile(path, 'utf8');

function replaceOnce(oldValue, newValue, label) {
  const count = source.split(oldValue).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, got ${count}`);
  source = source.replace(oldValue, newValue);
}

replaceOnce(
  '    <img class="cover-main" id="gMainImg" src="${escapeHtml(mainImage)}" alt="${safeTitle}" loading="eager" width="260" data-title="${safeTitle}">',
  '    <img class="cover-main" id="gMainImg" src="${escapeHtml(mainImage)}" alt="${safeTitle}" loading="eager" fetchpriority="high" decoding="async" width="260" height="390" data-title="${safeTitle}">',
  'main cover image',
);

replaceOnce(
  '      <img class="lb-img" id="glbImg" src="${escapeHtml(mainImage)}" alt="${safeTitle}" loading="eager">',
  '      <img class="lb-img" id="glbImg" alt="${safeTitle}" decoding="async">',
  'lightbox image',
);

replaceOnce(
  "    cur=idx;opener=trigger||mainBtn;\n    lb.removeAttribute('hidden');\n    document.body.style.overflow='hidden';\n    updateLb();lb.focus();",
  "    cur=idx;opener=trigger||mainBtn;\n    updateLb();lb.removeAttribute('hidden');\n    document.body.style.overflow='hidden';\n    lb.focus();",
  'lightbox open order',
);

replaceOnce(
  '    .cover-main{width:100%;max-width:260px;border-radius:.5rem;\n                box-shadow:0 4px 20px rgba(0,0,0,.12);display:block;background:white}',
  '    .cover-main{width:100%;max-width:260px;height:auto;aspect-ratio:2/3;object-fit:contain;border-radius:.5rem;\n                box-shadow:0 4px 20px rgba(0,0,0,.12);display:block;background:white}',
  'cover CSS',
);

replaceOnce(
  '      <img src="/images/logo-amado.webp" alt="Amado Libros" class="brand-logo" width="44" height="44" fetchpriority="high">',
  '      <img src="/images/logo-amado.webp" alt="Amado Libros" class="brand-logo" width="44" height="44" decoding="async">',
  'header logo priority',
);

replaceOnce(
  '      <a class="btn btn-wa" href="https://wa.me/${WA}?text=${waMsg}" target="_blank" rel="noopener noreferrer">\n        💬 Consultar por WhatsApp\n      </a>',
  '      <a class="btn btn-wa btn-secondary" href="https://wa.me/${WA}?text=${waMsg}" target="_blank" rel="noopener noreferrer">\n        💬 Consultar por WhatsApp\n      </a>',
  'in-stock whatsapp class',
);

replaceOnce(
  '    .btn-wa{background:#25d366;color:white}\n    .btn-cart{background:#e49982;color:#fff;border:none;font-family:inherit;',
  '    .btn-wa{background:#25d366;color:white}\n    .btn-wa.btn-secondary{background:#fff;color:#128c45;border:1.5px solid #25d366}\n    .btn-wa.btn-secondary:hover{background:#f0fff5;opacity:1}\n    .btn-cart{background:#e49982;color:#fff;border:none;font-family:inherit;',
  'CTA hierarchy CSS',
);

await writeFile(path, source);
