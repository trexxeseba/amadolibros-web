// Prueba temporal (no se mergea): valida publicaciones tradicionales de Arnoia, sin crear nada.
// La foto es una imagen de prueba ya alojada en Mercado Libre: solo sirve para validar, no para publicar.
process.env.HERMES_PORTADA_PRUEBA = 'https://http2.mlstatic.com/D_NQ_NP_633282-MLU79054756017_092024-O.jpg';
process.argv = [process.argv[0], 'publicar.mjs', 'hermes-monitor/data/arnoia-semana-45.json', '/tmp/pub-prueba.json', '--fuente=arnoia', '--tradicional', '--max=4'];
await import('./publicar.mjs');
