import importlib.util, unittest, tempfile
from pathlib import Path
from zipfile import ZipFile
from xml.sax.saxutils import escape
spec=importlib.util.spec_from_file_location('feed',Path(__file__).with_name('prepare-supplier-feed.py'))
feed=importlib.util.module_from_spec(spec);spec.loader.exec_module(feed)
class SupplierParserTest(unittest.TestCase):
 def workbook(self,path,date,headers):
  values=[['Pagina : 1 - '+date],headers,['9786075272795','Libro','27700','+2','0.3']]
  xml='<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
  for index,row in enumerate(values,1):
   xml+='<row r="'+str(index)+'">'
   for col,value in enumerate(row):xml+='<c r="'+chr(65+col)+str(index)+'" t="inlineStr"><is><t>'+escape(value)+'</t></is></c>'
   xml+='</row>'
  xml+='</sheetData></worksheet>'
  with ZipFile(path,'w') as z:z.writestr('xl/worksheets/sheet1.xml',xml)
 def test_single_digit_date(self):
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory)/'feed.xlsx';self.workbook(path,'25/8/2026 01:04:11',['ISBN','Titulo','Precio','Disponibilidad','Peso'])
   result=feed.read_feed(path)
   self.assertEqual(result['source_date'],'2026-08-25T01:04:11-03:00');self.assertEqual(len(result['rows']),1)
 def test_price_only_is_not_stock(self):
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory)/'prices.xlsx';self.workbook(path,'17/10/2026 01:04:11',['ISBN','Titulo','PVP','Fecha'])
   with self.assertRaisesRegex(ValueError,'missing_supplier_date_or_columns'):feed.read_feed(path)
if __name__=='__main__':unittest.main()
