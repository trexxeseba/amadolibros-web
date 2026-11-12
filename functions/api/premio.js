import { fetchCheckoutCatalog } from '../_shared/catalog.js';
import { createPremioHandler } from './_premio_handler.js';

export const onRequest = createPremioHandler({ fetchCatalog: fetchCheckoutCatalog });
