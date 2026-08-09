from pathlib import Path

p = Path('functions/libro/[[path]].js')
s = p.read_text()
old = '      <div class="price-transfer">Transferencia: $${transferPrice} UYU</div>'
new = '      <div class="price-transfer"><span class="price-transfer-label">Transferencia:</span> <strong>$${transferPrice} UYU</strong><span class="discount-badge" aria-label="12 por ciento de descuento">12% OFF</span></div>'
if s.count(old) != 1:
    raise SystemExit(f'price transfer marker mismatch: {s.count(old)}')
s = s.replace(old, new)
old2 = '    .price-transfer{font-size:.85rem;font-weight:600;color:#a94e3d;margin-top:.35rem}'
new2 = '''    .price-transfer{display:flex;align-items:center;flex-wrap:wrap;gap:.35rem .5rem;
                    font-size:1rem;font-weight:700;color:#a94e3d;margin-top:.55rem}
    .price-transfer strong{font-size:1.08rem;color:#8f3f30}
    .price-transfer-label{font-weight:700}
    .discount-badge{display:inline-flex;align-items:center;justify-content:center;
                    padding:.22rem .5rem;border-radius:999px;background:#8f3f30;color:#fff;
                    font-size:.8rem;font-weight:900;letter-spacing:.035em;line-height:1;
                    white-space:nowrap}'''
if s.count(old2) != 1:
    raise SystemExit(f'price style marker mismatch: {s.count(old2)}')
p.write_text(s.replace(old2, new2))

p = Path('functions/__tests__/product-image-cwv.test.js')
s = p.read_text()
marker = "test('transferencia destaca el ahorro con sello 12% OFF sin reemplazar precio web'"
if marker not in s:
    s += r'''

test('transferencia destaca el ahorro con sello 12% OFF sin reemplazar precio web', () => {
  const body = html({ price: 1650 });
  assert.match(body, /Precio web\/tarjeta:<\/span> \$1\.650 UYU/);
  assert.match(body, /Transferencia:<\/span> <strong>\$1\.452 UYU<\/strong>/);
  assert.match(body, />12% OFF<\/span>/);
  assert.match(body, /class="discount-badge" aria-label="12 por ciento de descuento"/);
});
'''
p.write_text(s)
