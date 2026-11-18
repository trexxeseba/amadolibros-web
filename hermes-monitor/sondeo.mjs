// Prueba temporal (no se mergea): valida publicaciones tradicionales de Arnoia, sin crear nada.
process.argv = [process.argv[0], 'publicar.mjs', 'hermes-monitor/data/arnoia-semana-45.json', '/tmp/pub-prueba.json', '--fuente=arnoia', '--tradicional', '--max=6'];
await import('./publicar.mjs');
