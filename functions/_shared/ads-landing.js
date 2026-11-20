// Ficha para quien llega desde un anuncio de Google (gclid / utm_source=google).
//
// La ficha se sirve igual para todos (HTML cacheado en el borde), así que la
// diferencia se aplica en el navegador, antes de pintar:
//   1. "Comprar en MercadoLibre" se oculta: el camino es el carrito, con
//      WhatsApp como segunda opción.
//   2. Los links de WhatsApp suman "Origen: Google Ads" al mensaje, para que
//      quien atiende sepa de dónde viene la consulta.
// No toca precios, carrito ni checkout.

export const ADS_ORIGIN_LINE = 'Origen: Google Ads';

// Esconde el botón de Mercado Libre solo cuando el script de cabecera marcó la página.
export const ADS_LANDING_STYLES = 'html.from-google-ads .btn-ml{display:none}';

// Se inyecta en <head>: marca <html> antes del primer render (sin parpadeo) y,
// con el DOM listo, agrega la línea de origen a todo link de wa.me.
export const ADS_LANDING_SCRIPT = `<script>(function(){try{
var q=new URLSearchParams(location.search);
var fromGoogle=!!(q.get('gclid')||q.get('gbraid')||q.get('wbraid')||String(q.get('utm_source')||'').toLowerCase()==='google');
if(!fromGoogle)return;
document.documentElement.classList.add('from-google-ads');
var LINE=${JSON.stringify(ADS_ORIGIN_LINE)},KEY='?text=';
function tag(href){var i=href.indexOf(KEY);if(i<0)return href;
var text;try{text=decodeURIComponent(href.slice(i+KEY.length));}catch(e){return href;}
if(text.indexOf(LINE)>-1)return href;
var re=/(^|\\n)(Página: [^\\n]*)/;
text=re.test(text)?text.replace(re,function(m){return m+'\\n'+LINE;}):(text?text+'\\n'+LINE:LINE);
return href.slice(0,i+KEY.length)+encodeURIComponent(text);}
function apply(){var links=document.querySelectorAll('a[href^="https://wa.me/"]');
for(var n=0;n<links.length;n++)links[n].setAttribute('href',tag(links[n].getAttribute('href')));}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',apply);else apply();
}catch(e){}})();</script>`;
