// Reseñas de Google de Amado Libros, copiadas tal cual las escribieron los
// clientes (se recortan solo en límite de oración; sin editar el contenido).
//
// Fuente: ficha de Google Maps de Amado Libros | Librería Online.
// Relevadas el 18/11/2026: 4,9 de 5 con 82 reseñas (80 de 5 estrellas).
// Para actualizar: cambiar GOOGLE_RATING y sumar o reemplazar entradas de
// GOOGLE_REVIEWS. Nombre abreviado a nombre + inicial.
//
// IMPORTANTE (SEO): no agregar datos estructurados Review/AggregateRating de
// estas reseñas. Google no los muestra para reseñas de la propia empresa
// (self-serving reviews) y puede penalizar el marcado.

export const GOOGLE_RATING = Object.freeze({
  rating: '4,9',
  count: 82,
  asOf: '2026-11-18',
});

export const GOOGLE_REVIEWS_URL = 'https://maps.google.com/?cid=11879259971653710404';
export const GOOGLE_WRITE_REVIEW_URL = '/opinar/';

export const GOOGLE_REVIEWS = Object.freeze([
  { name: 'Marce M.', text: 'La experiencia fue muy buena. Ustedes me brindaron mucha seguridad y resultaron ser muy responsables. Agradezco la atención recibida.' },
  { name: 'Gerardo P.', text: 'Excelente Amado Libros. Pedí los dos tomos de un libro de Rosemberg para estudio. Hace más de un año que los buscaba en todo el mundo y no exagero. No los pude conseguir hasta que me contacté con esta Empresa sería y me los consiguieron.' },
  { name: 'Monica H.', text: 'Me asesoraron re bien por WhatsApp y me pudieron mandar el libro en el día. Seguiré siendo clienta seguro!!!' },
  { name: 'Leonardo H.', text: 'La idea de que puedan conseguir libros buscando en distintas librerías de todo el mundo es genial y muy innovadora. Gracias a ustedes pude tener un libro que quería desde hace más de 20 años! Y todo en unos pocos días.' },
  { name: 'Washington B.', text: 'Siempre han cumplido en tiempo y forma, excelente atención, recomiendo 100 %' },
  { name: 'Ana U.', text: 'Excelente servicio. Me consiguieron un libro que no encontraba en el país y llegó antes de lo esperado. En todo momento la atención fue excelente, siempre muy atentos y amables.' },
  { name: 'Daniel A.', text: 'Excelente servicio. Atención. Explicaciones claras, personalizada, entrega a tiempo. Muy recomendable.' },
  { name: 'Claudia C.', text: 'Excelente atención, me respondieron todo enseguida, de forma muy amable! Muy sencillo comprar con ellos vía online, los recomiendo 100%' },
  { name: 'Lourdes J.', text: 'Muy recomendable. Han logrado siempre que me lleguen aquellos libros difíciles de encontrar a un precio razonable y con rápida entrega.' },
  { name: 'Cecilia T.', text: 'Excelente atención de Sebastian y todo el equipo. Muy buen asesoramiento de compra y búsqueda de textos.' },
  { name: 'Natalia E.', text: 'Conseguí con ellos un libro que estaba bastante agotado. Me respondieron enseguida, fueron súper amables y rápidos en coordinar la entrega.' },
  { name: 'Alicia G.', text: 'Muy buena respuesta. Pude conseguir dos libros que llevaba tiempo intentando adquirir en una tarde. Los recomiendo ampliamente.' },
  { name: 'Sara D.', text: 'Excelente experiencia. Las expectativas que tenia se han cumplido cuando creí que tenia todo perdido. Muy amables' },
  { name: 'Estefani Y.', text: 'Muy puntuales con la entrega y responsables. Tienen buen trato para atender.' },
  { name: 'Adriana P.', text: 'Excelente pido un libro del exterior y ellos se encargan de todo.!!' },
  { name: 'Miguel P.', text: 'Gracias a Amado Libros he conseguido títulos descatalogados. Muy eficientes y cordiales' },
  { name: 'Florencia M.', text: 'Muy amables y rápida atención. Buscaba un libro para mí hijo y fueron los únicos en conseguirlo' },
  { name: 'Luis F.', text: 'Excelente atención. Consigue libros realmente difíciles de conseguir.' },
]);

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hashString(value) {
  let h = 0;
  const s = String(value ?? '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Elige `limit` reseñas. Con `seed` (por ejemplo el id del libro) la elección
 * cambia de una ficha a otra pero es estable para cada una.
 */
export function pickReviews(limit = 6, seed = '') {
  const total = GOOGLE_REVIEWS.length;
  const n = Math.max(1, Math.min(Number(limit) || 6, total));
  const start = seed ? hashString(seed) % total : 0;
  return Array.from({ length: n }, (_, i) => GOOGLE_REVIEWS[(start + i) % total]);
}

export const GOOGLE_REVIEWS_CSS = `
.gr{max-width:1100px;margin:0 auto}
.gr-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.5rem 1.25rem;margin-bottom:1rem}
.gr-head h2{font-size:1.15rem;line-height:1.3;margin:0}
.gr-score{font-size:.9rem;color:#475569;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
.gr-stars{color:#f59e0b;letter-spacing:.08em}
.gr-list{column-gap:1rem;column-count:1;margin:0;padding:0;list-style:none}
@media (min-width:640px){.gr-list.gr-cols-2,.gr-list.gr-cols-3{column-count:2}}
@media (min-width:980px){.gr-list.gr-cols-3{column-count:3}}
.gr-card{break-inside:avoid;margin:0 0 1rem;padding:1rem 1.1rem;background:#fff;border:1px solid #e2e8f0;border-radius:.6rem}
.gr-card blockquote{margin:0;font-size:.92rem;line-height:1.55;color:#1e293b}
.gr-card figcaption{margin-top:.6rem;font-size:.8rem;color:#64748b;display:flex;align-items:center;gap:.5rem}
.gr-card .gr-stars{font-size:.8rem}
.gr-foot{display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;margin-top:.25rem;font-size:.86rem}
.gr-foot a{color:#9a3412;font-weight:600}
.gr-js .gr-card{opacity:0;transform:translateY(-14px)}
.gr-js .gr-card.gr-in{opacity:1;transform:none;transition:opacity .55s ease,transform .55s ease;transition-delay:calc(var(--gr-i,0) * 90ms)}
@media (prefers-reduced-motion:reduce){.gr-js .gr-card,.gr-js .gr-card.gr-in{opacity:1;transform:none;transition:none}}
`;

// Cascada: las tarjetas aparecen una tras otra al entrar en pantalla. Sin JS
// (o con movimiento reducido) se ven todas desde el principio.
export const GOOGLE_REVIEWS_SCRIPT = `(function(){
var roots=document.querySelectorAll('[data-gr]');if(!roots.length)return;
var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if(reduce||!('IntersectionObserver' in window))return;
roots.forEach(function(root){root.classList.add('gr-js');
var cards=root.querySelectorAll('.gr-card');
cards.forEach(function(c,i){c.style.setProperty('--gr-i',i%6)});
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('gr-in');io.unobserve(e.target)}})},{rootMargin:'0px 0px -8% 0px'});
cards.forEach(function(c){io.observe(c)});});
})();`;

/**
 * HTML de la sección de reseñas. `withAssets` incluye CSS y script (usar en
 * una sola instancia por página).
 */
export function googleReviewsHtml({
  limit = 6,
  seed = '',
  columns = 3,
  title = 'Lo que cuentan quienes ya compraron',
  withAssets = true,
} = {}) {
  const items = pickReviews(limit, seed);
  const cols = columns === 1 ? '' : columns === 2 ? ' gr-cols-2' : ' gr-cols-3';
  const cards = items
    .map(
      (r) => `<li class="gr-card"><figure style="margin:0"><blockquote>${esc(r.text)}</blockquote><figcaption><span class="gr-stars" aria-label="5 estrellas">★★★★★</span><span>${esc(r.name)} · reseña en Google</span></figcaption></figure></li>`,
    )
    .join('');
  return `${withAssets ? `<style>${GOOGLE_REVIEWS_CSS}</style>` : ''}<section class="gr" data-gr aria-label="Reseñas de clientes en Google">
  <div class="gr-head">
    <h2>${esc(title)}</h2>
    <p class="gr-score"><span class="gr-stars" aria-hidden="true">★★★★★</span><span><strong>${esc(GOOGLE_RATING.rating)} de 5</strong> en Google · ${esc(GOOGLE_RATING.count)} reseñas</span></p>
  </div>
  <ul class="gr-list${cols}">${cards}</ul>
  <p class="gr-foot"><a href="${esc(GOOGLE_REVIEWS_URL)}" target="_blank" rel="noopener noreferrer">Ver las ${esc(GOOGLE_RATING.count)} reseñas en Google</a><a href="${esc(GOOGLE_WRITE_REVIEW_URL)}">Dejar mi reseña</a></p>
</section>${withAssets ? `<script>${GOOGLE_REVIEWS_SCRIPT}<\/script>` : ''}`;
}
