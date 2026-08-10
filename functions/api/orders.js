import { fetchCheckoutCatalog } from '../_shared/catalog.js';
import { createOrdersHandler } from './_orders_handler.js';

export const onRequest = createOrdersHandler({ fetchCatalog: fetchCheckoutCatalog });
