let MODO='import',MMARGEN='venta',CLIENTE='nuevo',LOADING=false;
const STORE='amado_cotizador_v6_online_sin_envio_origen';
const IDS=['t-usd','t-eur','t-ars','moneda','costo','peso','ckg','envDestino','lab','margen','sena','demora','margenrecu','clink','cml','dtransf','piso','redondeo','validez','pickup','tono','comp','canaldef'];
const $=id=>document.getElementById(id);
function parseNum(x){let s=String(x||'').trim().replace(/\s/g,''); if(!s)return 0; if(s.includes(',')&&s.includes('.'))s=s.replace(/\./g,'').replace(',','.'); else if(s.includes(','))s=s.replace(',','.'); else if(/^\d{1,3}(\.\d{3})+$/.test(s))s=s.replace(/\./g,''); const n=parseFloat(s); return Number.isFinite(n)?n:0;}
const v=id=>parseNum($(id).value), f=n=>Math.round(Number.isFinite(n)?n:0).toLocaleString('es-UY'), pct=n=>(Number.isFinite(n)?n:0).toLocaleString('es-UY',{minimumFractionDigits:1,maximumFractionDigits:1})+'%';
function setVal(id,val){$(id).value=val;calc();}
function toUyu(amount,mon){if(mon==='UYU')return amount;if(mon==='USD')return amount*v('t-usd');if(mon==='EUR')return amount*v('t-eur');if(mon==='ARS')return v('t-ars')>0?amount/v('t-ars'):0;return amount;}
function rdn(x){const step=Math.max(1,v('redondeo')||10);return Math.ceil(x/step)*step;}
function save(){if(LOADING)return;const data={MODO,MMARGEN,CLIENTE,values:{}};IDS.forEach(id=>data.values[id]=$(id).value);localStorage.setItem(STORE,JSON.stringify(data));}
function load(){try{const d=JSON.parse(localStorage.getItem(STORE)||'null');if(!d)return false;LOADING=true;MODO=d.MODO||'import';MMARGEN=d.MMARGEN||'venta';CLIENTE=d.CLIENTE||'nuevo';if(d.values)IDS.forEach(id=>{if(d.values[id]!==undefined)$(id).value=d.values[id];});LOADING=false;sync();calc();return true;}catch(e){LOADING=false;return false;}}
function sync(){
 $('b-import').classList.toggle('active',MODO==='import');$('b-reventa').classList.toggle('active',MODO==='reventa');
 $('importFields').classList.toggle('hidden',MODO!=='import');$('rowFlete').classList.toggle('hidden',MODO!=='import');
 $('l-costo').innerText=MODO==='import'?'Costo libro':'Costo proveedor/local';
 $('mm-venta').classList.toggle('active',MMARGEN==='venta');$('mm-costo').classList.toggle('active',MMARGEN==='costo');
 $('cl-nuevo').classList.toggle('active',CLIENTE==='nuevo');$('cl-recu').classList.toggle('active',CLIENTE==='recu');
}
function setModo(m){MODO=m;sync();calc();}
function setMargen(m){MMARGEN=m;sync();calc();}
function setCliente(c){CLIENTE=c;sync();calc();}
function borrarGuardado(){localStorage.removeItem(STORE);alert('Guardado borrado.');}
function resetDefaults(){MODO='import';MMARGEN='venta';CLIENTE='nuevo';const d={'t-usd':'42','t-eur':'49','t-ars':'37',moneda:'EUR',costo:'0',peso:'0,3',ckg:'8',envDestino:'270',lab:'0',margen:'23',sena:'50',demora:'15 a 20 días',margenrecu:'18',clink:'12',cml:'17',dtransf:'12',piso:'200',redondeo:'10',validez:'7',pickup:'150',tono:'importado',comp:'0',canaldef:'ml'};Object.entries(d).forEach(([k,val])=>$(k).value=val);sync();calc();}
function preset(p){
 if(p==='espana'){MODO='import';CLIENTE='nuevo';MMARGEN='venta';Object.entries({moneda:'EUR',ckg:'8',envDestino:'270',lab:'0',margen:'23',margenrecu:'18',demora:'15 a 20 días',tono:'importado'}).forEach(([k,val])=>$(k).value=val);}
 if(p==='argentina'){MODO='import';CLIENTE='nuevo';MMARGEN='venta';Object.entries({moneda:'ARS',ckg:'8',envDestino:'270',lab:'0',margen:'23',margenrecu:'18',demora:'15 a 20 días',tono:'importado'}).forEach(([k,val])=>$(k).value=val);}
 if(p==='reventa'){MODO='reventa';CLIENTE='nuevo';MMARGEN='venta';Object.entries({moneda:'UYU',envDestino:'270',lab:'0',margen:'20',margenrecu:'18',demora:'15 a 20 días',tono:'neutro'}).forEach(([k,val])=>$(k).value=val);}
 sync();calc();
}
function channel(price,comm,id,total,lab,piso){
 const com=price*comm,neta=price-com-total,bruta=neta+lab,mg=price>0?neta/price*100:0;
 $('p-'+id).innerText='$ '+f(price);$('cm-'+id).innerText='$'+f(com);$('br-'+id).innerText='$'+f(bruta);$('ne-'+id).innerText='$'+f(neta);$('mg-'+id).innerText=pct(mg);
 const card=$('c-'+id),chip=$('v-'+id),ne=$('ne-'+id);card.classList.remove('bad','warn');chip.className='chip';
 let cls='good',txt='CONVIENE';if(neta<0){cls='bad';txt='PERDÉS'}else if(neta<piso){cls='bad';txt='BAJO PISO'}else if(neta<piso*1.5){cls='warn';txt='AL LÍMITE'}
 chip.classList.add(cls);chip.innerText=txt;ne.className='mval '+(cls==='bad'?'rd':cls==='warn'?'or':'gr');if(cls==='bad')card.classList.add('bad');if(cls==='warn')card.classList.add('warn');
 return{p:price,neta,comm};
}
function calc(){
 const mon=$('moneda').value;
 const libro=toUyu(v('costo'),mon);
 const flete=MODO==='import'?v('peso')*v('ckg')*v('t-usd'):0;
 const destino=v('envDestino'), lab=v('lab'), piso=v('piso'), total=libro+flete+destino+lab, fijos=libro+flete+destino;
 const margen=(CLIENTE==='recu'?v('margenrecu'):v('margen'))/100, clink=v('clink')/100, cml=v('cml')/100, dtransf=v('dtransf')/100;
 $('s-libro').innerText='$'+f(libro);$('s-flete').innerText='$'+f(flete);$('s-destino').innerText='$'+f(destino);$('s-lab').innerText='$'+f(lab);$('s-total').innerText='$'+f(total);
 $('s-detalle').innerText=`Compra ${$('costo').value} ${mon}`+(MODO==='import'?` + ${$('peso').value} kg x USD ${$('ckg').value}/kg`:'')+` + envío destino $${f(destino)} + laburo $${f(lab)}.`;
 function obj(comm){return MMARGEN==='venta'?((1-comm-margen)>0?rdn(total/(1-comm-margen)):0):rdn(total*(1+margen)/(1-comm));}
 const pLink=obj(clink), pTransf=rdn(pLink*(1-dtransf)), pML=obj(cml);$('labd').innerText=f(v('dtransf'));
 const rT=channel(pTransf,0,'transf',total,lab,piso),rL=channel(pLink,clink,'link',total,lab,piso),rM=channel(pML,cml,'ml',total,lab,piso);
 const cd=$('canaldef').value,sel=cd==='ml'?rM:cd==='link'?rL:rT,comm=sel.comm,comp=v('comp'),pisoSano=rdn((total+piso)/(1-comm)),pisoLab=rdn(total/(1-comm)),pisoDuro=rdn(fijos/(1-comm));
 const L=$('ladder');L.innerHTML=`<div class="lr"><span>Tu precio objetivo</span><b>$${f(sel.p)}</b></div><div class="lr"><span>Piso sano: laburo + piso</span><b>$${f(pisoSano)}</b></div><div class="lr"><span>Piso cubriendo laburo</span><b>$${f(pisoLab)}</b></div><div class="lr"><span>Límite absoluto sin pagarte</span><b>$${f(pisoDuro)}</b></div>`;
 const rows=L.querySelectorAll('.lr'),D=$('decision'),R=$('reco');
 if(comp>0){const nc=comp*(1-comm)-total;if(comp>=sel.p){rows[0].classList.add('good');D.className='decision good';D.innerHTML=`Ya estás igual o más barato. No bajes.`;R.innerHTML='<b>Movida:</b> vendé entrega, confianza, cuotas y gestión.';}else if(comp>=pisoSano){rows[1].classList.add('good');D.className='decision good';D.innerHTML=`Podés igualar: te quedan $${f(nc)} netos reales.`;R.innerHTML='<b>Movida:</b> igualá solo si lo piden o el cliente vale la pena.';}else if(comp>=pisoLab){rows[2].classList.add('warn');D.className='decision warn';D.innerHTML=`Cubrís laburo, pero quedás debajo del piso neto.`;R.innerHTML='<b>Movida:</b> solo recurrente o estratégico.';}else if(comp>=pisoDuro){rows[3].classList.add('warn');D.className='decision warn';D.innerHTML=`Cubrís costos duros, pero no te pagás bien.`;R.innerHTML='<b>Movida:</b> no iguales salvo excepción.';}else{rows[3].classList.add('bad');D.className='decision bad';D.innerHTML=`A ese precio perdés plata.`;R.innerHTML='<b>Movida:</b> no vendas perdiendo.';}}
 else{D.className='decision';D.innerHTML='Cargá precio competidor para evaluar si conviene igualar.';R.innerHTML='<b>Tip:</b> tu defensa mínima sana es laburo + piso neto.';}
 const tono=$('tono').value,enc=tono==='importado'?'🌍 IMPORTADO A PEDIDO\nEl precio incluye gestión de compra, importación y envío dentro de Uruguay. Lo traemos especialmente para usted.':'📚 LO CONSEGUIMOS A PEDIDO\nEl precio incluye la gestión y el envío dentro de Uruguay. Lo conseguimos especialmente para usted.';
 const senaMonto=rdn(pTransf*v('sena')/100),pickup=v('pickup');let retiro=pickup>0?`\n📍 Retiro por nuestro punto de entrega: descuento de $${f(pickup)}.`:'';
 $('msg').value=`${enc}\n\n💳 PVP / tarjeta hasta 12 cuotas: $${f(pLink)}\n💵 Transferencia bancaria (-${f(v('dtransf'))}%): $${f(pTransf)}\n   (3 cuotas de aprox. $${f(pLink/3)})\n   (6 cuotas de aprox. $${f(pLink/6)})\n   (12 cuotas de aprox. $${f(pLink/12)})\n\n🚚 ENVÍO GRATIS A TODO EL PAÍS.${retiro}\n📦 Demora estimada: ${$('demora').value} desde la confirmación.\n🔖 Para iniciar la gestión solicitamos seña del ${f(v('sena'))}%: aprox. $${f(senaMonto)}.\n\nCotización válida por ${f(v('validez'))} días. Sujeta a disponibilidad.\n\nQuedamos atentos para ayudarle. Gracias por comunicarse con Amado Libros.`;
 save();
}
async function copiar(){const t=$('msg'),b=$('bcopy'),old=b.innerText;try{await navigator.clipboard.writeText(t.value)}catch(e){t.select();document.execCommand('copy')}b.innerText='Copiado';b.style.background='#16a34a';setTimeout(()=>{b.innerText=old;b.style.background='var(--dark)'},1300)}
IDS.forEach(id=>$(id).addEventListener('change',calc));
window.onload=()=>{if(!load())resetDefaults();};
