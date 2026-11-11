/**
 * El Acertijo del Librero: HTML, estilos y script para /liquidacion.
 * El acertijo de hoy se pide a GET /api/acertijo (sin caché) y la respuesta
 * la valida el servidor. Si se falla, el servidor entrega un premio de la Rueda
 * y la página lo muestra girando la misma rueda.
 */
import { whatsappHref } from '../../shared/whatsapp-messages.js';

export const ACERTIJO_STYLES = `
    .acertijo{margin:0 0 1.25rem;padding:1.25rem;border-radius:1rem;background:#fff;border:1px solid #e2dbd0;color:#18120e;display:grid;gap:.7rem}
    .acertijo[hidden]{display:none}
    .acertijo *{box-sizing:border-box}
    .acertijo h2{font-family:"Playfair Display",Georgia,serif;font-size:1.3rem;line-height:1.2}
    .acertijo-pregunta{font-size:1.02rem;font-weight:600}
    .acertijo-form{display:grid;gap:.6rem;max-width:460px}
    .acertijo-form label{font-size:.85rem;font-weight:700}
    .acertijo-form input[type=text],.acertijo-form input[type=tel]{width:100%;font:inherit;padding:.75rem;border-radius:.6rem;border:1px solid #d1c8be;background:#faf7f2;min-height:48px}
    .acertijo-btn{width:100%;min-height:48px;padding:.65rem 1.1rem;border:0;border-radius:.6rem;background:#18120e;color:#fff8f0;font:inherit;font-weight:800;cursor:pointer}
    .acertijo-btn[disabled]{opacity:.6;cursor:default}
    .acertijo-msg{min-height:1.4em;font-size:.9rem;color:#64748b}
    .acertijo-msg.is-error{color:#b3261e}
    .acertijo-premio{border:1px solid #d1c8be;border-radius:.8rem;padding:1rem;background:#fdeee8}
    .acertijo-premio strong.cod{display:block;font-size:1.5rem;letter-spacing:.12em;margin:.2rem 0}
    .acertijo-premio a{display:inline-flex;margin-top:.7rem;min-height:44px;align-items:center;padding:.55rem 1rem;border-radius:.6rem;background:#1a9e4b;color:#fff;font-weight:800;text-decoration:none}
`;

export function acertijoHtml() {
    return `<section class="acertijo" id="acertijo" aria-labelledby="acertijo-titulo" data-wa="${whatsappHref('__CODIGO__').replace(/"/g, '&quot;')}" hidden>
  <p class="liq-eyebrow" style="color:#a94e3d">El Acertijo del Librero</p>
  <h2 id="acertijo-titulo">Un acertijo literario por día</h2>
  <p>Si acertás, te llevás $450 de descuento y un regalo de Amado. Si no, igual te regalamos un giro de la rueda.</p>
  <p class="acertijo-pregunta" id="acertijo-pregunta"></p>
  <form class="acertijo-form" id="acertijo-form" novalidate>
    <label for="acertijo-resp">Tu respuesta</label>
    <input id="acertijo-resp" name="respuesta" type="text" maxlength="120" autocomplete="off" required>
    <label for="acertijo-wa">Tu número de WhatsApp</label>
    <input id="acertijo-wa" name="whatsapp" type="tel" inputmode="tel" autocomplete="tel" placeholder="099 123 456" required>
    <div style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden" aria-hidden="true"><label>Sitio web<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
    <button class="acertijo-btn" id="acertijo-enviar" type="submit">Responder</button>
    <p class="acertijo-msg" id="acertijo-msg" role="status" aria-live="polite"></p>
  </form>
  <div class="acertijo-premio" id="acertijo-premio" hidden></div>
</section>`;
}

export const ACERTIJO_SCRIPT = `<script>
(function(){
  var root=document.getElementById('acertijo'); if(!root) return;
  var form=document.getElementById('acertijo-form'), msg=document.getElementById('acertijo-msg');
  var btn=document.getElementById('acertijo-enviar'), box=document.getElementById('acertijo-premio');
  var preg=document.getElementById('acertijo-pregunta'), waBase=root.getAttribute('data-wa'), hoy=null;
  function ev(name,params){try{if(typeof window.gtag==='function')window.gtag('event',name,params||{});}catch(e){}}
  fetch('/api/acertijo',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(j){
    if(!j||!j.pregunta) return; hoy=j; preg.textContent=j.pregunta; root.hidden=false; ev('juego_visto',{juego:'acertijo'});
  }).catch(function(){});
  function mostrarAcierto(d){
    var link=waBase.replace(encodeURIComponent('__CODIGO__'),encodeURIComponent('Hola, tengo el código '+d.code+' para este libro'));
    box.innerHTML='';
    var t=document.createElement('p'); t.textContent=d.repeat?'Tu código de hoy sigue vigente:':'Acertaste. Ganaste $'+d.monto_uyu+' de descuento y un regalo: '+d.regalo+'. Tu código:';
    var c=document.createElement('strong'); c.className='cod'; c.textContent=d.code;
    var v=document.createElement('p'); v.textContent='Vale '+d.valid_hours+' horas y se usa una sola vez. Elegí tu libro de la liquidación y mandanos el código por WhatsApp.';
    var a=document.createElement('a'); a.href=link; a.target='_blank'; a.rel='noopener noreferrer'; a.textContent='Mandar mi código por WhatsApp';
    a.addEventListener('click',function(){ev('codigo_enviado_whatsapp',{juego:'acertijo',premio:d.monto_uyu});});
    box.appendChild(t); box.appendChild(c); box.appendChild(v); box.appendChild(a); box.hidden=false;
  }
  form.addEventListener('submit',function(e){
    e.preventDefault(); if(btn.disabled||!hoy) return;
    msg.className='acertijo-msg'; msg.textContent='Revisando tu respuesta...'; btn.disabled=true;
    var data={id:hoy.id,respuesta:form.elements.respuesta.value,whatsapp:form.elements.whatsapp.value,website:form.elements.website.value};
    fetch('/api/acertijo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
      .then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});})
      .then(function(x){
        if(x.s!==200&&x.s!==201){msg.className='acertijo-msg is-error'; msg.textContent=(x.j&&x.j.error)||'No pudimos registrar tu respuesta. Probá de nuevo.'; btn.disabled=false; return;}
        var d=x.j; d.juego='acertijo';
        ev('acertijo_respondido',{juego:'acertijo',resultado:d.acerto?'acierto':'error'});
        if(d.acerto){msg.textContent=''; mostrarAcierto(d);}
        else{
          msg.textContent='No era esa, pero te regalamos un giro de la rueda.';
          var rueda=document.getElementById('rueda');
          if(rueda&&rueda.ruedaMostrar){rueda.scrollIntoView({behavior:'smooth',block:'center'}); rueda.ruedaMostrar(d);}
        }
      })
      .catch(function(){msg.className='acertijo-msg is-error'; msg.textContent='No pudimos conectar. Probá de nuevo.'; btn.disabled=false;});
  });
})();
</script>`;
