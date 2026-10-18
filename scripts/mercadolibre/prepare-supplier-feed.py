"""Convert the supplier XLSX to a private publication feed using stdlib only."""
import argparse,json,math,re,os,sys,unicodedata
from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from zipfile import ZipFile
from xml.etree import ElementTree as ET

NS={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
TAG='{'+NS['m']+'}row'
def label(value):
 return ''.join(c for c in unicodedata.normalize('NFD',str(value or '')).lower() if unicodedata.category(c)!='Mn').strip()
def isbn(value):
 s=re.sub('[^0-9Xx]','',str(value or '')).upper()
 if len(s)==10 and s[:9].isdigit() and (s[-1].isdigit() or s[-1]=='X') and sum((10-i)*(10 if c=='X' else int(c)) for i,c in enumerate(s))%11==0:
  stem='978'+s[:9];s=stem+str((10-sum(int(c)*(1 if i%2==0 else 3) for i,c in enumerate(stem))%10)%10)
 if len(s)!=13 or not s.isdigit() or sum(int(c)*(1 if i%2==0 else 3) for i,c in enumerate(s))%10:return None
 return s
def number(value):
 try:
  n=float(value)
  return n if math.isfinite(n) else None
 except (ValueError,TypeError):return None

def read_feed(path,weight_unit='kg'):
 if weight_unit not in ('kg','g'):raise ValueError('unsupported_weight_unit')
 rows=[];header=None;source_date=None
 with ZipFile(path) as z:
  if sum(info.file_size for info in z.infolist())>512*1024*1024:raise ValueError('uncompressed_workbook_too_large')
  strings=[]
  if 'xl/sharedStrings.xml' in z.namelist():strings=[''.join(si.itertext()) for si in ET.fromstring(z.read('xl/sharedStrings.xml'))]
  with z.open('xl/worksheets/sheet1.xml') as stream:
   for _,node in ET.iterparse(stream,events=('end',)):
    if node.tag!=TAG:continue
    values={}
    for cell in node:
     col=re.sub('[0-9]','',cell.attrib.get('r',''));v=cell.find('m:v',NS);value=v.text if v is not None else None
     if cell.attrib.get('t')=='s' and value is not None:value=strings[int(value)]
     elif cell.attrib.get('t')=='inlineStr':
      inline=cell.find('m:is',NS);value=''.join(inline.itertext()) if inline is not None else ''
     values[col]=value
    if int(node.attrib.get('r','0'))<=10 and not source_date:
     match=re.search(r'(\d{1,2}/\d{1,2}/\d{4}\s+\d{2}:\d{2}:\d{2})',str(values.get('A','')))
     if match:source_date=datetime.strptime(match.group(1),'%d/%m/%Y %H:%M:%S').replace(tzinfo=ZoneInfo('America/Argentina/Buenos_Aires')).isoformat()
    normalized={label(v):k for k,v in values.items() if v is not None}
    if all(k in normalized for k in ('isbn','titulo','precio','disponibilidad','peso')):header=normalized;node.clear();continue
    if header and any(v is not None for v in values.values()):
     get=lambda key:values.get(header.get(key,''))
     weight=number(get('peso'))
     rows.append({'isbn':isbn(get('isbn')),'title':str(get('titulo') or '').strip(),'author':str(get('autor') or '')[:300],'publisher':str(get('editorial') or '')[:200],'listArs':number(get('precio')),'weightKg':weight/1000 if weight is not None and weight_unit=='g' else weight,'stock':str(get('disponibilidad') or '').strip()[:30]})
    node.clear()
 if not source_date or not header:raise ValueError('missing_supplier_date_or_columns')
 counts=Counter(r['isbn'] for r in rows if r['isbn'])
 accepted=[];issues=Counter()
 for row in rows:
  reason=('invalid_isbn' if not row['isbn'] else 'duplicate_isbn' if counts[row['isbn']]>1 else 'missing_title' if not row['title'] else 'invalid_price' if row['listArs'] is None or row['listArs']<=0 else 'invalid_weight' if row['weightKg'] is None or not 0<row['weightKg']<=30 else None)
  if reason:issues[reason]+=1
  else:accepted.append(row)
 if not accepted:raise ValueError('no_eligible_supplier_rows')
 return {'source_date':source_date,'rows':accepted,'policy':json.loads(os.environ.get('PUBLISHER_POLICY_JSON','{}')),'source_summary':{'records':len(rows),'accepted':len(accepted),'excluded':dict(issues)}}

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('source');parser.add_argument('output');parser.add_argument('--weight-unit',choices=['kg','g'],default='kg');args=parser.parse_args()
 try:
  result=read_feed(args.source,args.weight_unit);Path(args.output).write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8');print(json.dumps(result['source_summary']))
 except Exception:
  print('Supplier workbook could not be validated.',file=sys.stderr);sys.exit(1)
