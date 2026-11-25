/**
 * El premio de la Rueda o del Acertijo en el navegador del cliente.
 *
 * Al ganar, el premio se guarda en este navegador (localStorage, clave
 * amado_premio) para que:
 * - el carrito lo cargue y lo descuente al pagar, sin escribir el código;
 * - la liquidación muestre un aviso con la cuenta regresiva y, en cada libro,
 *   cuánto queda con el premio.
 * Lo que se muestra acá es una vista previa con las mismas reglas que
 * precioConPremio (juego.js); el precio que se cobra lo calcula el servidor.
 */
import { LIQUIDACION_PRECIO } from './descuentos.js';
import { PREMIO_MAX_TOTAL_DISCOUNT, PREMIO_PRICE_FLOOR_UYU } from './juego.js';

export const PREMIO_STORAGE_KEY = 'amado_premio';

export const PREMIO_STYLES = `
    .premio-banner{border:2px solid #1a7a3c;border-radius:1rem;background:#eef8f1;color:#123d24;padding:1rem;margin:1rem 0;display:grid;gap:.35rem}
    .premio-banner strong.monto{font-size:1.35rem}
    .premio-banner .reloj{font-weight:700}
    .premio-banner .cod{font-size:.85rem;color:#3d5a47}
    .premio-banner .cod b{letter-spacing:.08em}
    .rc-premio{display:block;font-size:.85rem;font-weight:800;color:#1a7a3c;margin-top:.15rem}
    .juego-premio-titulo{font-size:1.35rem;font-weight:800;margin:0 0 .25rem}
    .juego-premio-reloj{font-weight:700}
    .juego-premio-cod{font-size:.85rem;opacity:.85;margin-top:.5rem}
    .juego-premio-cod b{letter-spacing:.08em}
    .juego-premio-acciones{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-top:.7rem}
    .juego-premio-acciones a.elegir{display:inline-flex;min-height:44px;align-items:center;padding:.55rem 1rem;border-radius:.6rem;background:#e49982;color:#18120e;font-weight:800;text-decoration:none}
    .juego-premio-acciones a.wa-sec{background:none!important;color:inherit!important;text-decoration:underline!important;font-weight:600!important;padding:.4rem 0!important;margin:0!important}
`;

export function premioBannerHtml() {
    return '<div class="premio-banner" id="premio-banner" role="status" aria-live="polite" hidden></div>';
}

/** Funciones del navegador, compartidas por la Rueda, el Acertijo y la liquidación. */
export const PREMIO_LIB_SCRIPT = `<script>
(function(){
  if(window.AmadoPremio) return;
  var KEY=${JSON.stringify(PREMIO_STORAGE_KEY)};
  var BASE=${LIQUIDACION_PRECIO.discount}, TOPE=${PREMIO_MAX_TOTAL_DISCOUNT}, PISO=${PREMIO_PRICE_FLOOR_UYU};
  function pesos(n){return '$'+Math.round(n).toLocaleString('es-UY');}
  function leer(){
    try{var p=JSON.parse(localStorage.getItem(KEY)||'null');
      if(!p||typeof p.code!=='string') return null;
      if(p.expires_at&&Date.parse(p.expires_at)<=Date.now()){localStorage.removeItem(KEY);return null;}
      return p;}catch(e){return null;}
  }
  function guardar(d){
    if(!d||!d.code||d.monto_uyu==null) return;
    try{localStorage.setItem(KEY,JSON.stringify({code:d.code,monto_uyu:d.monto_uyu,expires_at:d.expires_at,umbral_uyu:d.umbral_uyu||null,juego:d.juego||'rueda'}));}catch(e){}
    try{document.dispatchEvent(new CustomEvent('amado-premio'));}catch(e){}
  }
  function faltan(iso){
    var ms=Date.parse(iso)-Date.now(); if(!(ms>0)) return '';
    var h=Math.floor(ms/3600000), d=Math.floor(h/24), r=h%24, m=Math.floor((ms%3600000)/60000);
    if(d>0) return d+(d===1?' día':' días')+(r?' y '+r+(r===1?' hora':' horas'):'');
    if(h>0) return h+(h===1?' hora':' horas')+(m?' y '+m+' min':'');
    return m>1?m+' minutos':'menos de un minuto';
  }
  // Mismo cálculo que precioConPremio (juego.js), sin transferencia.
  function precioCon(habitual,monto){
    var h=Number(habitual), m=Number(monto); if(!(h>0)||!(m>0)) return null;
    var desc=Math.min(BASE*h+m,TOPE*h), p=Math.ceil(h-desc);
    if(p<PISO){ if(h<=PISO) return null; p=PISO; }
    return p;
  }
  window.AmadoPremio={leer:leer,guardar:guardar,faltan:faltan,precioCon:precioCon,pesos:pesos};
})();
</script>`;

/** Aviso del premio guardado y precio con premio en cada libro de la liquidación. */
export const PREMIO_LIQ_SCRIPT = `<script>
(function(){
  var P=window.AmadoPremio, banner=document.getElementById('premio-banner'); if(!P||!banner) return;
  var timer=null;
  function linea(texto,clase){var el=document.createElement(clase==='monto'?'strong':'p'); if(clase) el.className=clase; el.textContent=texto; return el;}
  function pintar(){
    var p=P.leer();
    if(!p){banner.hidden=true; banner.innerHTML=''; document.querySelectorAll('.rc-premio').forEach(function(n){n.remove();}); return;}
    banner.innerHTML='';
    banner.appendChild(linea('Tenés un premio de '+P.pesos(p.monto_uyu)+' para usar en la web','monto'));
    var f=P.faltan(p.expires_at);
    if(f) banner.appendChild(linea('Vence en '+f+'.','reloj'));
    banner.appendChild(linea('Se descuenta automáticamente cuando pagás en la web desde este dispositivo: elegí tu libro, tocá «Ver ficha» y sumalo al carrito.'+(p.umbral_uyu?' Lo aprovechás entero en cualquier libro desde '+P.pesos(p.umbral_uyu)+'.':'')));
    var c=document.createElement('p'); c.className='cod'; c.appendChild(document.createTextNode('Tu código: ')); var b=document.createElement('b'); b.textContent=p.code; c.appendChild(b); banner.appendChild(c);
    banner.hidden=false;
    document.querySelectorAll('.rc-card[data-precio]').forEach(function(card){
      var actual=Number(card.getAttribute('data-precio')), hab=Number(card.getAttribute('data-habitual'))||actual;
      var con=P.precioCon(hab,p.monto_uyu), box=card.querySelector('.rc-prices'), prev=card.querySelector('.rc-premio');
      if(prev) prev.remove();
      if(!box||con===null||!(con<actual)) return;
      var s=document.createElement('span'); s.className='rc-premio'; s.textContent='Con tu premio: '+P.pesos(con)+' UYU'; box.insertBefore(s,box.children[1]||null);
    });
    clearTimeout(timer); timer=setTimeout(pintar,60000);
  }
  document.addEventListener('amado-premio',pintar);
  pintar();
})();
</script>`;

/**
 * Arma el recuadro del premio recién ganado (Rueda o Acertijo). Recibe el
 * contenedor, la respuesta del servidor y el link de WhatsApp; devuelve el
 * enlace de WhatsApp para que el juego le enganche su evento.
 */
export const PREMIO_GANADO_FN = `function amadoPintarPremio(box,d,link,titulo){
  var P=window.AmadoPremio; if(P) P.guardar(d);
  box.innerHTML='';
  var texto=d.monto_uyu!=null?('$'+Number(d.monto_uyu).toLocaleString('es-UY')):(d.discount_pct+'%');
  var t=document.createElement('p'); t.className='juego-premio-titulo'; t.textContent=titulo||(d.repeat?'Tu premio de hoy sigue vigente: '+texto:'¡Ganaste '+texto+'!'); box.appendChild(t);
  var v=document.createElement('p');
  v.textContent='Se descuenta automáticamente cuando pagás en la web desde este dispositivo.'+(d.umbral_uyu?' Lo aprovechás entero en cualquier libro desde $'+Number(d.umbral_uyu).toLocaleString('es-UY')+'.':'');
  box.appendChild(v);
  var f=P?P.faltan(d.expires_at):''; if(f){var r=document.createElement('p'); r.className='juego-premio-reloj'; r.textContent='Tenés '+f+' para usarlo.'; box.appendChild(r);}
  var acc=document.createElement('div'); acc.className='juego-premio-acciones';
  var e=document.createElement('a'); e.className='elegir'; e.href='#premio-banner'; e.textContent='Elegir mi libro';
  e.addEventListener('click',function(ev){var g=document.querySelector('.grid'); if(g){ev.preventDefault(); g.scrollIntoView({behavior:'smooth',block:'start'});}});
  var a=document.createElement('a'); a.className='wa-sec'; a.href=link; a.target='_blank'; a.rel='noopener noreferrer'; a.textContent='Prefiero comprar por WhatsApp';
  acc.appendChild(e); acc.appendChild(a); box.appendChild(acc);
  var c=document.createElement('p'); c.className='juego-premio-cod'; c.appendChild(document.createTextNode('Tu código, por si comprás desde otro equipo o por WhatsApp: ')); var b=document.createElement('b'); b.textContent=d.code; c.appendChild(b); box.appendChild(c);
  box.hidden=false;
  return a;
}`;
