import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderPage } from '../libro/[[path]].js';

const book = {
  id: 'MLU123456789', title: 'Libro con galería', author: 'Autora',
  price: 1200, status: 'active', available_quantity: 1, condition: 'new',
  pictures: ['https://http2.mlstatic.com/D_FIRST-O.jpg', 'https://http2.mlstatic.com/D_SECOND-O.jpg'],
  thumbnail: '', permalink: 'https://articulo.mercadolibre.com.uy/test',
};

test('la ficha no solicita el zoom hasta abrirlo, y conserva calidad y navegación', () => {
  const html = renderPage(book, 'libro-con-galeria');
  const zoomTag = html.match(/<img[^>]*id="glbImg"[^>]*>/)?.[0];
  assert.ok(zoomTag);
  assert.doesNotMatch(zoomTag, /\s(?:src|srcset)=/);
  assert.match(html, /id="gMainImg"[^>]*src="[^"]+"/);
  const script = html.match(/<script>\(function\(\)\{\n  var imgs=[\s\S]*?<\/script>/)?.[0];
  assert.ok(script, 'gallery controller is present');

  const requests = [];
  function node(attrs = {}, image = false) {
    return {
      attrs: { ...attrs }, listeners: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k] ?? null; },
      removeAttribute(k) { delete this.attrs[k]; },
      hasAttribute(k) { return k in this.attrs; },
      addEventListener(k, fn) { this.listeners[k] = fn; },
      focus() {},
      set src(v) { if (image) requests.push(v); this.attrs.src = v; },
      get src() { return this.attrs.src; },
    };
  }
  const nodes = {
    glb: node({ hidden: '' }), glbImg: node({}, true), glbCounter: node(),
    gMainBtn: node({ 'data-current-index': '0' }),
    gMainImg: node({ 'data-title': book.title }), glbClose: node(),
  };
  const prev = node(), next = node();
  const thumbs = [node(), node()];
  const document = {
    body: { style: {} }, listeners: {},
    getElementById(id) { return nodes[id]; },
    querySelectorAll() { return thumbs; },
    querySelector(s) { return s === '.lb-prev' ? prev : next; },
    addEventListener(k, fn) { this.listeners[k] = fn; },
  };
  vm.runInNewContext(script.slice('<script>'.length, -'</script>'.length), { document });
  assert.deepEqual(requests, [], 'initial controller does not fetch the hidden zoom');
  nodes.gMainBtn.listeners.click();
  assert.equal(requests.length, 1);
  assert.match(requests[0], /width=1024,quality=88/);
  assert.match(requests[0], /cover\.jpg$/);
  next.listeners.click();
  assert.match(requests[1], /cover-2\.jpg$/);
  assert.match(requests[1], /width=1024,quality=88/);
  prev.listeners.click();
  assert.equal(requests[2], requests[0]);
  nodes.glbClose.listeners.click();
  assert.ok(nodes.glb.hasAttribute('hidden'));
  thumbs[1].listeners.click();
  nodes.gMainBtn.listeners.click();
  assert.equal(requests[3], requests[1], 'reopens the selected image');
});
