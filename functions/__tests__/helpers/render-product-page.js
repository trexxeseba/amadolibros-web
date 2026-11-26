// Run the same client behavior against source and against the actual bundler.
// CI invokes the bundled mode after installing Astro's locked dependencies.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
let pageModule;
if (process.env.PRODUCT_CLIENT_TEST_BUNDLE === 'true') {
  const require = createRequire(new URL('../../../astro-front/package.json', import.meta.url));
  const { build } = require('esbuild');
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../../libro/[[path]].js', import.meta.url))],
    bundle: true, format: 'esm', platform: 'neutral', keepNames: true, write: false,
  });
  pageModule = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
} else {
  pageModule = await import('../../libro/[[path]].js');
}
export const renderPage = pageModule.renderPage;
