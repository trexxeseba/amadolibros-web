/**
 * La Rueda del Librero: HTML, estilos y script para /liquidacion.
 * El navegador solo anima: el premio lo devuelve POST /api/rueda.
 * Con animaciones apagadas (prefers-reduced-motion) muestra el premio sin girar.
 */
import { RUEDA_PREMIOS } from './juego.js';
import { whatsappHref } from '../../shared/whatsapp-messages.js';

const N = RUEDA_PREMIOS.length;
const SLICE = 360 / N;
const COLORS = ['#2a201a', '#a94e3d', '#3a2d24', '#c2705e', '#2a201a', '#e49982'];

function slicePath(i) {
    const a0 = (i * SLICE - 90) * Math.PI / 180, a1 = ((i + 1) * SLICE - 90) * Math.PI / 180;
    const p = (a, r) => `${(100 + r * Math.cos(a)).toFixed(2)},${(100 + r * Math.sin(a)).toFixed(2)}`;
    return `M100,100 L${p(a0, 96)} A96,96 0 0 1 ${p(a1, 96)} Z`;
}

function discoSvg() {
    const slices = RUEDA_PREMIOS.map((pr, i) => {
        const mid = (i * SLICE + SLICE / 2);
        const a = (mid - 90) * Math.PI / 180;
        const x = 100 + 66 * Math.cos(a), y = 100 + 66 * Math.sin(a);
        return `<path d="${slicePath(i)}" fill="${COLORS[i % COLORS.length]}" stroke="#faf7f2" stroke-width="1.2"/>` +
            `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="#fff8f0" font-size="15" font-weight="800" text-anchor="middle" dominant-baseline="middle" transform="rotate(${mid} ${x.toFixed(1)} ${y.toFixed(1)})">${pr.pct}%</text>`;
    }).join('');
    return `<svg viewBox="0 0 200 200" role="img" aria-label="Rueda con premios de ${RUEDA_PREMIOS[0].pct}% a ${RUEDA_PREMIOS[N - 1].pct}% de descuento">${slices}<circle cx="100" cy="100" r="9" fill="#faf7f2" stroke="#18120e" stroke-width="2"/></svg>`;
}

// Gatito sentado, inspirado en el logo de Amado. Dibujo liviano en SVG.
const GATO_SVG = `<svg viewBox="0 0 130 140" aria-hidden="true" focusable="false">
<path d="M30 132c-10-22-6-52 14-66l-4-26 20 14c8-3 16-3 24 0l20-14-4 26c20 14 24 44 14 66z" fill="#18120e" stroke="#e49982" stroke-width="2.5" stroke-linejoin="round"/>
<circle cx="50" cy="72" r="4" fill="#e49982"/><circle cx="82" cy="72" r="4" fill="#e49982"/>
<path d="M62 82l4 4 4-4" fill="none" stroke="#e49982" stroke-width="2.5" stroke-linecap="round"/>
<g class="gato-pata"><path d="M24 96c-14 2-20 14-14 22 6 6 16 2 22-8z" fill="#18120e" stroke="#e49982" stroke-width="2.5" stroke-linejoin="round"/></g>
</svg>`;

export const RUEDA_STYLES = `
    .rueda{margin:0 0 1.25rem;padding:1.25rem;border-radius:1rem;background:#18120e;color:#fff8f0;display:grid;gap:1.1rem}
    .rueda>*{min-width:0}
    .rueda *{box-sizing:border-box}
    .rueda-escena{order:-1}
    .rueda h2{font-family:"Playfair Display",Georgia,serif;font-size:1.35rem;line-height:1.2;margin:.2rem 0 .4rem}
    .rueda p{color:rgba(255,248,240,.85);font-size:.95rem}
    .rueda-escena{position:relative;display:flex;justify-content:center;align-items:flex-end;gap:.5rem;min-height:230px}
    .rueda-marco{position:relative;width:min(70vw,260px);aspect-ratio:1}
    .rueda-puntero{position:absolute;top:-6px;left:50%;width:0;height:0;margin-left:-10px;border-left:10px solid transparent;border-right:10px solid transparent;border-top:20px solid #e49982;z-index:2}
    .rueda-disco{width:100%;height:100%;border-radius:50%;box-shadow:0 0 0 4px #e49982;transition:transform 4.2s cubic-bezier(.12,.7,.15,1)}
    .rueda-gato{width:min(26vw,100px);flex:0 0 auto}
    .gato-pata{transform-box:fill-box;transform-origin:90% 80%}
    .rueda.is-spinning .gato-pata{animation:gato-empuja 1.1s ease-in-out 1}
    @keyframes gato-empuja{0%{transform:rotate(0)}35%{transform:rotate(-28deg) translateX(10px)}100%{transform:rotate(0)}}
    .rueda-form{display:grid;gap:.6rem;max-width:420px}
    .rueda-form label{font-size:.85rem;font-weight:700}
    .rueda-form input[type=tel]{width:100%;font:inherit;padding:.75rem;border-radius:.6rem;border:1px solid #6b5a4d;background:#fff8f0;color:#18120e;min-height:48px}
    .rueda-trampa{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
    .rueda-btn{width:100%;min-height:48px;padding:.65rem 1.1rem;border:0;border-radius:.6rem;background:#e49982;color:#18120e;font:inherit;font-weight:800;cursor:pointer}
    .rueda-btn[disabled]{opacity:.6;cursor:default}
    .rueda-msg{min-height:1.4em;font-size:.9rem}
    .rueda-msg.is-error{color:#ffb4a6}
    .rueda-premio{border:1px solid #6b5a4d;border-radius:.8rem;padding:1rem;background:#241a14}
    .rueda-premio strong.cod{display:block;font-size:1.6rem;letter-spacing:.12em;margin:.2rem 0}
    .rueda-premio a{display:inline-flex;margin-top:.7rem;min-height:44px;align-items:center;padding:.55rem 1rem;border-radius:.6rem;background:#25d366;color:#0b2b17;font-weight:800;text-decoration:none}
    @media(min-width:760px){.rueda{grid-template-columns:1fr 1fr;align-items:center;padding:1.5rem}.rueda-escena{order:0}}
    @media (prefers-reduced-motion:reduce){.rueda-disco{transition:none}.rueda.is-spinning .gato-pata{animation:none}}
`;

export function ruedaHtml() {
    return `<section class="rueda" id="rueda" aria-labelledby="rueda-titulo" data-wa="${whatsappHref('__CODIGO__').replace(/"/g, '&quot;')}">
  <div>
    <p class="liq-eyebrow">La Rueda del Librero</p>
    <h2 id="rueda-titulo">Girá la rueda y llevate un descuento extra</h2>
    <p>Un giro por día. Si tenés suerte, tu código llega hasta 25% menos. Dura 48 horas y lo usás por WhatsApp, con el libro que elijas de la liquidación.</p>
    <form class="rueda-form" id="rueda-form" novalidate>
      <label for="rueda-wa">Tu número de WhatsApp</label>
      <input id="rueda-wa" name="whatsapp" type="tel" inputmode="tel" autocomplete="tel" placeholder="099 123 456" required>
      <div class="rueda-trampa" aria-hidden="true"><label>Sitio web<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
      <button class="rueda-btn" id="rueda-girar" type="submit">Girar la rueda</button>
      <p class="rueda-msg" id="rueda-msg" role="status" aria-live="polite"></p>
    </form>
    <div class="rueda-premio" id="rueda-premio" hidden></div>
  </div>
  <div class="rueda-escena">
    <div class="rueda-marco"><span class="rueda-puntero"></span><div class="rueda-disco" id="rueda-disco">${discoSvg()}</div></div>
    <div class="rueda-gato">${GATO_SVG}</div>
  </div>
</section>`;
}

export const RUEDA_PREMIOS_JSON = JSON.stringify(RUEDA_PREMIOS.map(p => p.pct));

export const RUEDA_SCRIPT = `<script>
(function(){
  var root=document.getElementById('rueda'); if(!root) return;
  var premios=${RUEDA_PREMIOS_JSON}, slice=${SLICE};
  var form=document.getElementById('rueda-form'), msg=document.getElementById('rueda-msg');
  var btn=document.getElementById('rueda-girar'), disco=document.getElementById('rueda-disco');
  var box=document.getElementById('rueda-premio'), waBase=root.getAttribute('data-wa');
  var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function ev(name,params){try{if(typeof window.gtag==='function')window.gtag('event',name,params||{});}catch(e){}}
  ev('juego_visto',{juego:'rueda'});
  function mostrar(d){
    var idx=premios.indexOf(d.discount_pct); if(idx<0) idx=0;
    var jitter=(Math.random()-0.5)*(slice*0.5);
    var vueltas=reduce?0:5*360;
    var grados=vueltas+(360-(idx*slice+slice/2))+jitter;
    root.classList.add('is-spinning'); disco.style.transform='rotate('+grados+'deg)';
    var espera=reduce?0:4300;
    setTimeout(function(){
      root.classList.remove('is-spinning');
      var link=waBase.replace(encodeURIComponent('__CODIGO__'),encodeURIComponent('Hola, tengo el código '+d.code+' para este libro'));
      box.innerHTML='';
      var t=document.createElement('p'); t.textContent=d.repeat?'Tu código de hoy sigue vigente:':'Ganaste '+d.discount_pct+'% de descuento. Tu código:';
      var c=document.createElement('strong'); c.className='cod'; c.textContent=d.code;
      var v=document.createElement('p'); v.textContent='Vale '+d.valid_hours+' horas y se usa una sola vez. Elegí tu libro de la liquidación y mandanos el código por WhatsApp.';
      var a=document.createElement('a'); a.href=link; a.target='_blank'; a.rel='noopener noreferrer'; a.textContent='Mandar mi código por WhatsApp';
      a.addEventListener('click',function(){ev('codigo_enviado_whatsapp',{juego:d.juego||'rueda',premio:d.discount_pct});});
      box.appendChild(t); box.appendChild(c); box.appendChild(v); box.appendChild(a); box.hidden=false;
      msg.textContent=''; msg.className='rueda-msg'; btn.disabled=false;
      if(!d.repeat) ev('rueda_girada',{juego:d.juego||'rueda',premio:d.discount_pct});
    },espera);
  }
  root.ruedaMostrar=mostrar;
  form.addEventListener('submit',function(e){
    e.preventDefault(); if(btn.disabled) return;
    msg.className='rueda-msg'; msg.textContent='Girando...'; btn.disabled=true;
    var data={whatsapp:form.elements.whatsapp.value,website:form.elements.website.value};
    fetch('/api/rueda',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
      .then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});})
      .then(function(x){
        if(x.s===200||x.s===201){mostrar(x.j);return;}
        msg.className='rueda-msg is-error'; msg.textContent=(x.j&&x.j.error)||'No pudimos darte el giro. Probá de nuevo.'; btn.disabled=false;
      })
      .catch(function(){msg.className='rueda-msg is-error'; msg.textContent='No pudimos conectar. Probá de nuevo.'; btn.disabled=false;});
  });
})();
</script>`;
