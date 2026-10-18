import {unzipSync,strFromU8} from './vendor/fflate-0.8.3.mjs';
const fail=code=>{throw Error(code);};
const norm=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
function xmlText(value){
 return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,entity)=>{
  if(entity[0]==='#'){const n=entity[1].toLowerCase()==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}
  return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity.toLowerCase()];
 });
}
const textRuns=xml=>[...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m=>xmlText(m[1])).join('');
function canonical(value){
 let s=String(value??'').replace(/[^0-9Xx]/g,'').toUpperCase();
 if(/^\d{9}[\dX]$/.test(s)&&[...s].reduce((n,c,i)=>n+(10-i)*(c==='X'?10:Number(c)),0)%11===0){const stem='978'+s.slice(0,9);s=stem+((10-[...stem].reduce((n,c,i)=>n+Number(c)*(i%2?3:1),0)%10)%10);}
 return /^\d{13}$/.test(s)&&[...s].reduce((n,c,i)=>n+Number(c)*(i%2?3:1),0)%10===0?s:null;
}
export function sourceDate(value){
 const m=String(value??'').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
 if(!m)return null;
 const [d,month,y,h,minute,s]=m.slice(1).map(Number),date=new Date(Date.UTC(y,month-1,d));
 if(date.getUTCFullYear()!==y||date.getUTCMonth()!==month-1||date.getUTCDate()!==d||h>23||minute>59||s>59)fail('invalid_supplier_date');
 const pad=n=>String(n).padStart(2,'0');return `${y}-${pad(month)}-${pad(d)}T${pad(h)}:${pad(minute)}:${pad(s)}-03:00`;
}
export function readSelectedStock(buffer,isbns){return readStock(buffer,isbns);}
export function readFullStock(buffer){return readStock(buffer,null);}
function readStock(buffer,isbns){
 const bytes=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer);
 if(bytes.length<4||bytes.length>64*1024*1024)fail('invalid_workbook_size');
 if(isbns!==null&&(!Array.isArray(isbns)||isbns.length!==5||new Set(isbns).size!==5||isbns.some(x=>canonical(x)!==x)))fail('five_selected_isbns_required');
 const wanted=isbns===null?null:new Set(isbns),allowed=new Set(['xl/sharedStrings.xml','xl/worksheets/sheet1.xml']);let expanded=0;
 let files;
 try{files=unzipSync(bytes,{filter:entry=>{if(!allowed.has(entry.name))return false;expanded+=entry.originalSize;if(entry.originalSize>128*1024*1024||expanded>160*1024*1024)fail('workbook_too_large');return true;}});}catch{fail('invalid_or_oversized_workbook');}
 if(!files['xl/worksheets/sheet1.xml'])fail('missing_supplier_sheet');
 const sharedXml=files['xl/sharedStrings.xml']?strFromU8(files['xl/sharedStrings.xml']):'';
 const sheet=strFromU8(files['xl/worksheets/sheet1.xml']);
 if(/<!DOCTYPE|<!ENTITY/i.test(sharedXml+sheet.slice(0,2048)))fail('unsupported_workbook_xml');
 const strings=[...sharedXml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map(m=>textRuns(m[1]??''));
 let date=null,header=null,records=0,rejected=0;const matches=new Map(),conflicts=new Set(),seen=new Set();
 for(const row of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)){
  const number=Number(row[1].match(/\br="(\d+)"/)?.[1]),values={};
  for(const cell of (row[2]??'').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
   const col=cell[1].match(/\br="([A-Z]+)\d+"/)?.[1];if(!col)continue;
   if(cell[2]===undefined){values[col]='';continue;}
   const type=cell[1].match(/\bt="([^"]+)"/)?.[1],raw=cell[2].match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1]??'';
   if(type==='s'){const index=Number(raw);if(!Number.isInteger(index)||index<0||index>=strings.length)fail('invalid_shared_string');values[col]=strings[index];}
   else values[col]=type==='inlineStr'?textRuns(cell[2]):xmlText(raw);
  }
  if(number<=10&&!date)date=sourceDate(values.A);
  const labels=Object.fromEntries(Object.entries(values).map(([c,v])=>[norm(v),c]));
  if(['isbn','titulo','precio','disponibilidad','peso'].every(k=>labels[k])){header=labels;continue;}
  if(!header)continue;
  const get=key=>values[header[key]]??'',isbn=canonical(get('isbn'));if(!get('isbn'))continue;records++;
  if(wanted&&!wanted.has(isbn))continue;
  if(!wanted&&isbn){if(seen.has(isbn)){matches.delete(isbn);conflicts.add(isbn);rejected++;continue;}seen.add(isbn);}
  const listArs=Number(get('precio')),weightKg=Number(get('peso')),title=get('titulo').trim(),stock=get('disponibilidad').trim();
  if(!isbn||!title||title.length>600||!Number.isFinite(listArs)||listArs<=0||!Number.isFinite(weightKg)||weightKg<=0||weightKg>30){if(wanted)fail('invalid_selected_book');rejected++;continue;}
  if(!/^\+?\d+$/.test(stock)||Number(stock)<=0){if(wanted)fail('selected_book_without_stock');rejected++;continue;}
  if(matches.has(isbn)||conflicts.has(isbn)){if(wanted)fail('duplicate_selected_isbn');matches.delete(isbn);conflicts.add(isbn);rejected++;continue;}
  matches.set(isbn,{isbn,title,author:get('autor').slice(0,300),publisher:get('editorial').slice(0,200),listArs,weightKg,stock});
 }
 if(!date||!header)fail('stock_columns_or_date_missing');
 if(wanted&&matches.size!==5)fail('selected_isbn_missing');
 if(!wanted&&(!matches.size||matches.size>250000))fail('invalid_supplier_rows');
 return {source_date:date,rows:wanted?isbns.map(isbn=>matches.get(isbn)):[...matches.values()],records,rejected,duplicate_isbns:conflicts.size};
}
