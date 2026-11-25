// Números de la campaña sin llamar a Mercado Libre: lista de SBS del día contra los recibos
// de Amado Vintage que devuelve el servidor en la conexión.
import {hasSupplierStock,quoteMercadoLibre} from '../../worker-sync/publication-policy.js';
export function campaignNumbers(rows,receipts,policy){
 const byIsbn=new Map(),published=new Set(),pending=new Set();
 for(const r of receipts??[]){byIsbn.set(r.isbn,r);if(r.state==='published')published.add(r.isbn);else pending.add(r.isbn);}
 const inStock=rows.filter(r=>hasSupplierStock(r.stock));
 const inStockSet=new Set(inStock.map(r=>r.isbn));
 const candidates=inStock.filter(r=>!byIsbn.has(r.isbn));
 const prices=[];
 for(const r of candidates){try{prices.push(quoteMercadoLibre(r,{...policy,competitive:false}).price);}catch{}}
 prices.sort((a,b)=>a-b);
 const at=q=>prices.length?prices[Math.min(prices.length-1,Math.floor(q*prices.length))]:null;
 const bands=[[0,1999],[2000,2999],[3000,4999],[5000,Infinity]].map(([lo,hi])=>({desde:lo,hasta:hi===Infinity?null:hi,libros:prices.filter(p=>p>=lo&&p<=hi).length}));
 return {
  filas_lista:rows.length,con_stock:inStock.length,
  publicados:published.size,sin_confirmar:pending.size,
  publicados_con_stock:[...published].filter(i=>inStockSet.has(i)).length,
  publicados_sin_stock_hoy:[...published].filter(i=>!inStockSet.has(i)).length,
  candidatos_nuevos:candidates.length,
  precio_lista_completo:{minimo:prices[0]??null,mediana:at(.5),p90:at(.9),maximo:prices.at(-1)??null,por_franja:bands},
 };
}
