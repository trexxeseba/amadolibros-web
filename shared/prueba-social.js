// Carteles de prueba social REALES.
//
// Alternan dos tipos de aviso, ambos verdaderos y verificables:
//   1. Reseñas de Google Business (las mismas de shared/google-reviews.js,
//      copiadas tal cual del perfil, con el nombre abreviado).
//   2. Ventas recientes de la tienda en Mercado Libre, leídas de /api/prueba-social
//      (tabla ml_sales_* de D1). Solo viajan título y antigüedad de la venta:
//      nunca nombre, ciudad, teléfono ni número de pedido del comprador.
//
// Regla: no se inventan nombres, ventas ni cantidades. Si no hay ventas
// recientes, el cartel de ventas no se muestra y quedan solo las reseñas.
// Sin Review/AggregateRating en datos estructurados (ver google-reviews.js).
import { GOOGLE_REVIEWS, GOOGLE_REVIEWS_URL } from './google-reviews.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Reseñas cortas para el cartel: texto completo si es breve, si no se corta en una palabra. */
export function reviewSnippet(text, max = 120) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const base = cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).replace(/[\s,;:.\-–—]+$/, '');
  return `${base}…`;
}

/** "hoy", "ayer" o "hace N días" a partir de la antigüedad en días enteros. */
export function relativeDays(days) {
  const d = Math.max(0, Math.floor(Number(days) || 0));
  if (d === 0) return 'hoy';
  if (d === 1) return 'ayer';
  return `hace ${d} días`;
}

export const PRUEBA_SOCIAL_REVIEWS = Object.freeze(
  GOOGLE_REVIEWS.map((r) => Object.freeze({ name: r.name, text: reviewSnippet(r.text) })),
);

export const PRUEBA_SOCIAL_CSS = `
.ps-toast{position:fixed;left:.75rem;right:4.75rem;bottom:calc(5.75rem + env(safe-area-inset-bottom,0px));z-index:55;max-width:21rem;
  background:#fff;color:#1F1B18;border:1px solid #E4DCCF;border-radius:.9rem;box-shadow:0 8px 28px rgba(31,27,24,.16);
  padding:.75rem 2rem .75rem .85rem;font:400 .85rem/1.45 Inter,system-ui,sans-serif;
  opacity:0;transform:translateY(12px);pointer-events:none;transition:opacity .35s ease,transform .35s ease}
.ps-toast.ps-on{opacity:1;transform:none;pointer-events:auto}
.ps-toast .ps-kind{display:block;font-size:.72rem;letter-spacing:.02em;color:#5A524B;margin-bottom:.2rem}
.ps-toast .ps-stars{color:#C98A00;letter-spacing:.08em}
.ps-toast .ps-body{display:block;color:#1F1B18}
.ps-toast .ps-body strong{font-weight:600}
.ps-toast a{color:#B4442A;text-decoration:underline;text-underline-offset:2px}
.ps-toast .ps-x{position:absolute;top:.25rem;right:.3rem;width:1.75rem;height:1.75rem;border:0;background:transparent;color:#5A524B;font-size:1.1rem;line-height:1;cursor:pointer;border-radius:50%}
.ps-toast .ps-x:focus-visible{outline:2px solid #B4442A}
@media (min-width:768px){.ps-toast{left:1.25rem;right:auto;bottom:1.25rem}}
@media (prefers-reduced-motion:reduce){.ps-toast{transition:none;transform:none}}
body.has-buy-bar .ps-toast{bottom:calc(7.5rem + env(safe-area-inset-bottom,0px))}
@media (min-width:768px){body.has-buy-bar .ps-toast{bottom:1.25rem}}
`;

// Se serializa con JSON para no depender de comillas ni saltos dentro del texto.
export function pruebaSocialScript({ reviews = PRUEBA_SOCIAL_REVIEWS, reviewsUrl = GOOGLE_REVIEWS_URL, endpoint = '/api/prueba-social' } = {}) {
  const data = JSON.stringify({ reviews, reviewsUrl, endpoint }).replace(/</g, '\\u003c');
  return `(function(){
var CFG=${data};
var p=location.pathname;
if(/^\\/(carrito|checkout|pago|pedido|cuenta|panel|gracias|opinar)(\\/|$)/.test(p))return;
var MAX=4,KEY='ps_n',n=0;
try{n=parseInt(sessionStorage.getItem(KEY)||'0',10)||0;if(sessionStorage.getItem('ps_off')==='1')return;}catch(e){}
if(n>=MAX)return;
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function rel(d){d=Math.max(0,Math.floor(+d||0));return d===0?'hoy':d===1?'ayer':'hace '+d+' d\\u00edas';}
function cut(t,m){t=String(t).replace(/\\s+/g,' ').trim();return t.length<=m?t:t.slice(0,m).replace(/\\s+\\S*$/,'').replace(/[\\s,;:.\\-]+$/,'')+'\\u2026';}
var box=document.createElement('aside');box.className='ps-toast';box.setAttribute('role','status');box.setAttribute('aria-live','polite');
box.innerHTML='<button class="ps-x" type="button" aria-label="Cerrar">\\u00d7</button><div class="ps-in"></div>';
document.body.appendChild(box);
var inner=box.querySelector('.ps-in');
box.querySelector('.ps-x').addEventListener('click',function(){box.classList.remove('ps-on');try{sessionStorage.setItem('ps_off','1');}catch(e){}stop=true;});
var stop=false,sales=[],ri=Math.floor(Math.random()*CFG.reviews.length),si=0,turn=0;
function reviewMsg(){var r=CFG.reviews[ri%CFG.reviews.length];ri++;return '<span class="ps-kind"><span class="ps-stars" aria-label="5 estrellas">\\u2605\\u2605\\u2605\\u2605\\u2605</span> Rese\\u00f1a en Google</span><span class="ps-body">\\u201c'+esc(r.text)+'\\u201d<br>'+esc(r.name)+' \\u00b7 <a href="'+esc(CFG.reviewsUrl)+'" target="_blank" rel="noopener noreferrer">ver en Google</a></span>';}
function saleMsg(){var s=sales[si%sales.length];si++;return '<span class="ps-kind">Mercado Libre</span><span class="ps-body">Se vendi\\u00f3 <strong>'+esc(cut(s.titulo,70))+'</strong> '+rel(s.dias)+' en nuestra tienda de Mercado Libre.</span>';}
function show(){
  if(stop||n>=MAX||document.hidden){if(!stop&&n<MAX)setTimeout(show,8000);return;}
  var useSale=sales.length>0&&turn%2===1;turn++;
  inner.innerHTML=useSale?saleMsg():reviewMsg();
  box.classList.add('ps-on');n++;try{sessionStorage.setItem(KEY,String(n));}catch(e){}
  setTimeout(function(){box.classList.remove('ps-on');if(n<MAX&&!stop)setTimeout(show,22000);},8000);
}
function start(){setTimeout(show,9000);}
try{
  fetch(CFG.endpoint,{credentials:'omit'}).then(function(r){return r.ok?r.json():{};}).then(function(j){
    if(j&&Array.isArray(j.ventas))sales=j.ventas.filter(function(v){return v&&v.titulo;}).slice(0,8);
  }).catch(function(){}).then(start);
}catch(e){start();}
})();`;
}

/** CSS + script listos para pegar en una página (Pages Functions). */
export function pruebaSocialHtml(opts = {}) {
  return `<style>${PRUEBA_SOCIAL_CSS}</style><script>${pruebaSocialScript(opts)}<\/script>`;
}

export { esc as _esc };
