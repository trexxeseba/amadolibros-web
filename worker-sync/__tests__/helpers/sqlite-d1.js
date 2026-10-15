import {execFileSync} from 'node:child_process';
const python=`import sys,json,sqlite3
db=sqlite3.connect(sys.argv[1],timeout=5)
db.row_factory=sqlite3.Row
request=json.load(sys.stdin)
out=[]
with db:
 for statement in request:
  cursor=db.execute(statement['sql'],statement.get('args',[]))
  rows=[dict(row) for row in cursor.fetchall()] if cursor.description else []
  out.append({'success':True,'results':rows,'meta':{'changes':max(cursor.rowcount,0)}})
print(json.dumps(out))
`;
export function sqliteD1(file){
 const execute=items=>JSON.parse(execFileSync('python3',['-c',python,file],{input:JSON.stringify(items),encoding:'utf8',stdio:['pipe','pipe','pipe']}));
 function statement(sql,args=[]) {
  return {
   sql,args,
   bind(...nextArgs){return statement(sql,nextArgs);},
   async first(){return execute([{sql,args}])[0].results[0]??null;},
   async all(){return execute([{sql,args}])[0];},
   async run(){return execute([{sql,args}])[0];},
  };
 }
 return {
  prepare:sql=>statement(sql),
  async batch(statements){return execute(statements.map(({sql,args})=>({sql,args})));},
 };
}
