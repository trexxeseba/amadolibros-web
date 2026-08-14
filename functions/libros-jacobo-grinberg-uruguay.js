import { renderAuthorRoute } from './_shared/author-page.js';

export function onRequest(ctx) {
  return renderAuthorRoute(ctx, 'jacobo-grinberg-zylberbaum');
}
