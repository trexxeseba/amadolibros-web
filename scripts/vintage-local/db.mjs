import {DatabaseSync} from 'node:sqlite';
export function openDatabase(path){
 const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
 const statement=(sql,args=[])=>({sql,args,bind(...values){return statement(sql,values);},async first(){return db.prepare(sql).get(...args)??null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}});
 return {prepare:sql=>statement(sql),close:()=>db.close(),async batch(statements){db.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>{const p=db.prepare(s.sql);return /^(SELECT|PRAGMA)\b|\bRETURNING\b/i.test(s.sql)?{results:p.all(...s.args),meta:{changes:1}}:{results:[],meta:{changes:Number(p.run(...s.args).changes)}};});db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}}};
}
