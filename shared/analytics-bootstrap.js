// Arranque liviano de la analítica (va inline en el <head>, sin descargas).
//
// Por qué existe: /analytics-events.js se carga con `defer` y gtag.js (unos
// 190 KB) se descarga recién después del primer pintado, para no frenar la
// carga en el celular. Este bloque deja listo desde el primer momento todo lo
// que el resto del HTML puede llamar antes de que lleguen esos archivos, así
// ningún evento se pierde ni cambia:
//
// - window.dataLayer y window.gtag(): gtag() sólo agrega a dataLayer, igual
//   que el fragmento oficial de Google. Cuando gtag.js llega procesa la cola
//   en orden (js, config/page_view y después cada evento).
// - window.AmadoAnalytics: las mismas funciones públicas de
//   analytics-events.js como cola. Al cargar, analytics-events.js las
//   reemplaza por las reales y repite cada llamada guardada con sus mismos
//   argumentos. getMeasurementContext() nunca deja colgado el checkout: si la
//   respuesta real no llega a tiempo devuelve null, como hoy.
// - Clics tempranos: los clics anteriores a analytics-events.js se guardan
//   para medir el whatsapp_click que corresponda.
// - window.AmadoGtag.load(id): agrega el <script> de gtag.js. Se espera al
//   primero de: una interacción (toque, clic o tecla), el evento `load` más un
//   momento libre del navegador (con tope), la pestaña pasando a segundo plano
//   o un tope fijo de tiempo. En /carrito y /pedido se carga de inmediato,
//   como siempre: ahí salen begin_checkout y purchase, se lee el client_id
//   para la compra y la página se va a Mercado Pago.
//
// Las colas y los clics sólo existen en los dominios productivos, que es
// donde analytics-events.js mide; el cargador de gtag.js funciona en
// cualquier dominio, igual que el <script async> que reemplaza en Astro.
//
// Fuente única: lo usan BaseLayout.astro (Astro) y faviconHeadHtml() de
// functions/_shared/brand.js (páginas de Functions).

export const ANALYTICS_PRODUCTION_HOSTS = ['amadolibros.com', 'www.amadolibros.com'];
export const ANALYTICS_MEASUREMENT_ID = 'G-SDX45VEPP3';

function bootstrapJs(configure) {
return `(function(w,d){
var hosts=${JSON.stringify(ANALYTICS_PRODUCTION_HOSTS)};
if(!w.AmadoGtag){
var wanted=[],started={},ready=false,timers=[];
var now=/^\\/(carrito|pedido)(\\/|$)/.test(w.location.pathname);
var inject=function(id){
if(started[id])return;started[id]=1;
if(d.querySelector('script[src*="googletagmanager.com/gtag/js?id='+id+'"]'))return;
var s=d.createElement('script');s.async=true;
s.src='https://www.googletagmanager.com/gtag/js?id='+encodeURIComponent(id);
d.head.appendChild(s);
};
var trig=['pointerdown','touchstart','keydown','click'];
var go=function(){
if(ready)return;ready=true;
for(var i=0;i<trig.length;i++)w.removeEventListener(trig[i],go,true);
d.removeEventListener('visibilitychange',hidden);
for(var j=0;j<timers.length;j++)clearTimeout(timers[j]);
for(var k=0;k<wanted.length;k++)inject(wanted[k]);
};
var hidden=function(){if(d.visibilityState==='hidden')go();};
w.AmadoGtag={configured:{},load:function(id){if(ready)inject(id);else wanted.push(id);},loadNow:go};
if(now){ready=true;}else{
for(var t=0;t<trig.length;t++)w.addEventListener(trig[t],go,{capture:true,passive:true});
d.addEventListener('visibilitychange',hidden);
var idle=function(){if(w.requestIdleCallback)w.requestIdleCallback(go,{timeout:2000});else timers.push(setTimeout(go,1500));};
if(d.readyState==='complete')idle();else w.addEventListener('load',idle,{once:true});
timers.push(setTimeout(go,6000));
}
}
if(hosts.indexOf(w.location.hostname)<0)return;
w.dataLayer=w.dataLayer||[];
w.gtag=w.gtag||function(){w.dataLayer.push(arguments);};
var a=w.AmadoAnalytics=w.AmadoAnalytics||{};
if(a.__queue)return;
var q=a.__queue=[];
['trackWhatsApp','trackCommerce','trackCheckoutError','trackStockWaitlistCreated'].forEach(function(n){
if(typeof a[n]!=='function')a[n]=function(){q.push({name:n,args:arguments});};
});
if(typeof a.getMeasurementContext!=='function')a.getMeasurementContext=function(ms){
var args=arguments;
return new Promise(function(resolve){
var item={name:'getMeasurementContext',args:args,resolve:resolve,done:false};
q.push(item);
setTimeout(function(){if(!item.done){item.done=true;resolve(null);}},Math.max(100,Math.min(2000,Number(ms)||1200)));
});
};
var clicks=[];
var early=function(e){if(clicks)clicks.push(e.target);};
d.addEventListener('click',early,true);
a.__takeClicks=function(){d.removeEventListener('click',early,true);var c=clicks||[];clicks=null;return c;};
${configure ? CONFIGURE_JS : ''}})(window,document);`;
}

// Páginas de Functions: js + config de GA4 acá mismo, al principio del
// <head>, como hacía antes analytics-events.js cuando se cargaba sincrónico.
// Así cualquier gtag('event') de la página queda después del config.
// Mismo ID y misma limpieza de page_location que analytics-events.js.
const CONFIGURE_JS = `var id=${JSON.stringify(ANALYTICS_MEASUREMENT_ID)};
if(!w.AmadoGtag.configured[id]){
var allowed=['utm_id','utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','dclid','gbraid','wbraid'];
var u=new URL(w.location.href);
Array.from(u.searchParams.keys()).forEach(function(k){if(allowed.indexOf(k)<0)u.searchParams.delete(k);});
u.hash='';
w.gtag('js',new Date());
w.gtag('config',id,{page_location:u.toString()});
w.AmadoGtag.configured[id]=true;
w.AmadoGtag.load(id);
}
`;

// Astro (BaseLayout): el js + config los hace su propio inline con PUBLIC_GA_ID.
export const ANALYTICS_BOOTSTRAP_JS = bootstrapJs(false);
// Functions (faviconHeadHtml): además deja hecho el js + config de GA4.
export const ANALYTICS_BOOTSTRAP_WITH_CONFIG_JS = bootstrapJs(true);
