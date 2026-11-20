// Prueba temporal (no se mergea): ajusta el plazo de las publicaciones de Hermes. El modo se elige con HERMES_REAL_PLAZO=1.
process.argv = [process.argv[0], 'ajustar_plazo.mjs', 'hermes-monitor/ids-hermes-plazo.json', '18', ...(process.env.HERMES_REAL_PLAZO === '1' ? ['--real'] : [])];
await import('./ajustar_plazo.mjs');
