/**
 * Encabezado único de la tienda para las páginas SSR (catálogo, ficha,
 * temas, landings de tema). Replica la identidad de la portada: fondo
 * crema, marca en tipografía editorial, terracota como acento. Antes cada
 * página tenía el suyo (negro, azul marino, «← volver») y al navegar se
 * sentía otra tienda.
 *
 * Estructura, igual en todas las páginas:
 *   fila 1: marca · buscador · carrito
 *   fila 2: Libros · Temas · Pedir un libro · Nosotros
 * En el celular el buscador baja a su propia fila y los accesos se deslizan.
 */

import { BRAND } from './brand.js';

export const SITE_HEADER_NAV = Object.freeze([
    { id: 'libros', label: 'Libros', href: '/catalogo' },
    { id: 'temas', label: 'Temas', href: '/temas' },
    { id: 'pedir', label: 'Pedir un libro', href: '/pedir-libro/?tipo=exacto', highlight: true },
    { id: 'nosotros', label: 'Nosotros', href: '/quienes-somos/' },
]);

function escapeAttr(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** Tipografías de la portada (mismo proveedor y familias que BaseLayout.astro). */
export const SITE_FONTS_HEAD = `<link rel="preconnect" href="https://fonts.bunny.net" crossorigin>
  <link rel="stylesheet" href="https://fonts.bunny.net/css?family=playfair-display:700|inter:400,600,800&display=swap">`;

export function siteHeaderHtml({ current = '', query = '', showSearch = true } = {}) {
    const nav = SITE_HEADER_NAV.map(item => {
        const classes = ['site-nav-link'];
        if (item.highlight) classes.push('is-highlight');
        const isCurrent = item.id === current;
        return `<a class="${classes.join(' ')}" href="${item.href}"${isCurrent ? ' aria-current="page"' : ''}>${item.label}</a>`;
    }).join('');
    return `<header class="site-header">
  <div class="header-inner">
    <a href="/" class="brand-link" aria-label="Amado Libros — inicio">
      <img src="${BRAND.logo}" alt="${BRAND.logoAlt}" class="brand-logo" width="48" height="47" fetchpriority="high">
      <span class="brand-copy">
        <span class="brand-name">Amado Libros</span>
        <span class="brand-tagline">Librería en línea · Uruguay</span>
      </span>
    </a>
    ${showSearch ? `<form class="header-search" action="/catalogo" method="get" role="search">
      <input type="search" name="q" value="${escapeAttr(query)}" placeholder="Buscar por título, autor, temática o ISBN"
             aria-label="Buscar por título, autor, temática o ISBN" autocomplete="off">
      <button type="submit" aria-label="Buscar libros">Buscar</button>
    </form>` : '<span class="header-spacer" aria-hidden="true"></span>'}
    <a href="/carrito" id="ssr-cart-link" class="ssr-cart-link" aria-label="Ver carrito">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
        <path d="M1 1h4l2.68 13.39a2 2 0 001.98 1.61h9.72a2 2 0 001.98-1.61L23 6H6"/>
      </svg>
      <span id="ssr-cart-badge" class="ssr-cart-badge" hidden aria-hidden="true">0</span>
    </a>
  </div>
  <nav class="site-nav" aria-label="Navegación principal">${nav}</nav>
</header>`;
}

export const SITE_HEADER_STYLES = `
    .site-header{position:sticky;top:0;z-index:50;background:rgba(255,252,246,.97);
                 border-bottom:1px solid #e6dccf;color:#1b1714;
                 font-family:'Inter',system-ui,-apple-system,"Segoe UI",sans-serif;
                 -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
    .site-header .header-inner{width:100%;max-width:1180px;margin:0 auto;padding:.6rem 1rem .35rem;
                  display:grid;grid-template-columns:auto minmax(240px,640px) auto;
                  align-items:center;justify-content:space-between;gap:1rem}
    .site-header .brand-link{display:flex;align-items:center;gap:.6rem;min-width:max-content;
                color:#1b1714;text-decoration:none}
    .site-header .brand-logo{width:48px;height:47px;display:block;object-fit:contain;flex-shrink:0}
    .site-header .brand-copy{display:flex;flex-direction:column;line-height:1.1}
    .site-header .brand-name{font-family:'Playfair Display',Georgia,'Times New Roman',serif;
                font-size:1.25rem;font-weight:700;color:#1b1714}
    .site-header .brand-tagline{margin-top:.2rem;color:#6b625b;font-size:.62rem;font-weight:800;
                letter-spacing:.08em;text-transform:uppercase}
    .site-header .header-search{width:100%;height:44px;display:flex;align-items:stretch;
                   background:#fff;border:1px solid #d7cec2;border-radius:999px;overflow:hidden}
    .site-header .header-search:focus-within{border-color:#b4442a;box-shadow:0 0 0 3px rgba(180,68,42,.15)}
    .site-header .header-search input{min-width:0;flex:1;border:0;background:#fff;color:#1b1714;
                         padding:0 .25rem 0 1rem;font:inherit;font-size:.9rem;outline:0}
    .site-header .header-search input::placeholder{color:#8a8078}
    .site-header .header-search button{min-width:88px;border:0;background:#b4442a;color:#fff;
                          padding:0 1rem;font:inherit;font-size:.85rem;font-weight:800;cursor:pointer}
    .site-header .header-search button:hover{background:#9a3a23}
    .site-header .ssr-cart-link{position:relative;display:inline-flex;align-items:center;justify-content:center;
                   width:44px;height:44px;color:#1b1714;border:1px solid #d7cec2;border-radius:999px;
                   background:#fff;text-decoration:none;flex-shrink:0}
    .site-header .ssr-cart-link:hover{border-color:#b4442a;color:#b4442a}
    .site-header .ssr-cart-badge{position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;
                    padding:0 4px;border-radius:999px;background:#b4442a;color:#fff;
                    font-size:.65rem;font-weight:800;line-height:18px;text-align:center;pointer-events:none}
    .site-header nav.site-nav{max-width:1180px;margin:0 auto;padding:0 1rem .5rem;display:flex;gap:.35rem;
              overflow-x:auto;scrollbar-width:none;background:transparent;border:0;font-size:inherit;color:inherit}
    .site-nav::-webkit-scrollbar{display:none}
    .site-nav-link{flex:0 0 auto;display:inline-flex;align-items:center;min-height:36px;padding:.35rem .8rem;
                   border-radius:999px;color:#332d28;font-size:.86rem;font-weight:700;text-decoration:none}
    .site-nav-link:hover{background:#f0e8dc;color:#b4442a}
    .site-nav-link[aria-current="page"]{background:#1b1714;color:#fff8f0}
    .site-nav-link.is-highlight{color:#b4442a}
    @media(max-width:760px){
      .site-header .header-inner{grid-template-columns:minmax(0,1fr) auto;gap:.5rem .75rem;padding:.5rem .85rem .3rem}
      .site-header .brand-logo{width:40px;height:39px}
      .site-header .brand-name{font-size:1.1rem}
      .site-header .brand-tagline{display:none}
      .site-header .header-search{grid-column:1/-1;grid-row:2;height:42px}
      .site-header .ssr-cart-link{grid-column:2;grid-row:1;justify-self:end}
      .site-header .header-search input{font-size:.86rem;padding-left:.9rem}
      .site-header .header-search button{min-width:76px;padding:0 .8rem;font-size:.8rem}
      .site-header nav.site-nav{padding:0 .85rem .45rem}
      .site-nav-link{border:1px solid #e0d6c9;background:#fff}
    }
`;

/**
 * Contador del carrito: lee el mismo carrito que /cart.js (localStorage
 * «amado-cart») y escucha sus actualizaciones. Nunca rompe la página.
 */
export const SITE_HEADER_SCRIPT = `<script>(function(){
  function show(n){
    var badge=document.getElementById('ssr-cart-badge');
    var link=document.getElementById('ssr-cart-link');
    if(!badge||!link)return;
    if(n>0){badge.textContent=n>99?'99+':String(n);badge.hidden=false;
      link.setAttribute('aria-label','Ver carrito ('+(n===1?'1 artículo':n+' artículos')+')');}
    else{badge.hidden=true;link.setAttribute('aria-label','Ver carrito');}
  }
  function count(){
    try{var c=JSON.parse(localStorage.getItem('amado-cart')||'null');
      if(!c||!Array.isArray(c.items))return 0;
      return c.items.reduce(function(s,i){return s+(Number(i.quantity)||0);},0);}catch(e){return 0;}
  }
  document.addEventListener('DOMContentLoaded',function(){
    show(window.AmadoCart&&window.AmadoCart.count?window.AmadoCart.count():count());
    document.addEventListener('amado:cart-updated',function(e){
      var items=e.detail&&Array.isArray(e.detail.items)?e.detail.items:[];
      show(items.reduce(function(s,i){return s+(i.quantity||0);},0));
    });
  });
})();</script>`;
