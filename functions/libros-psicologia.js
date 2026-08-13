import { BASE } from './_shared/catalog.js';
import { specialtyPath } from './_shared/seo-specialties.js';

const CANONICAL = `${BASE}${specialtyPath('psicologia')}`;

export async function onRequest() {
  return Response.redirect(CANONICAL, 301);
}
