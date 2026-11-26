import { fetchCheckoutCatalog } from '../_shared/catalog.js';
import { createCheckoutHealthHandler } from './_checkout_health_handler.js';

export const onRequest = createCheckoutHealthHandler({ fetchCatalog: fetchCheckoutCatalog });
