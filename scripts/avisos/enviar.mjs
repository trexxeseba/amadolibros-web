// Manda por mail (Resend) un texto guardado en scripts/avisos/. Uso: node scripts/avisos/enviar.mjs <archivo.txt> "<asunto>"
// El destino sale de VINTAGE_EMAIL_TO o PRECIO_GANADOR_EMAIL_TO. Solo envía archivos de esta carpeta.
import fs from 'node:fs/promises';
import path from 'node:path';
import {sendMail} from '../vintage-cloud/aviso.mjs';
const [, , archivo, asunto] = process.argv;
if (!/^[a-z0-9-]+\.txt$/.test(archivo ?? '') || !asunto) { console.error('uso: enviar.mjs <archivo.txt> "<asunto>"'); process.exit(2); }
const texto = await fs.readFile(path.join(path.dirname(new URL(import.meta.url).pathname), archivo), 'utf8');
console.log('resultado:', await sendMail({asunto, texto, prefijo: 'Amado Vintage'}));
