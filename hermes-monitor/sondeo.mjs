// Corrección única (no se mergea): pone 18 días "a demanda" a las 111 publicaciones de Hermes. Decisión de Seba, 20/11/2026.
process.argv = [process.argv[0], 'ajustar_plazo.mjs', 'hermes-monitor/ids-hermes-plazo.json', '18', '--real'];
await import('./ajustar_plazo.mjs');
