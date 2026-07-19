import { fetchCatalog } from '../_shared/catalog.js';
import { createOrdersHandler } from './_orders_handler.js';

export const onRequest = createOrdersHandler({ fetchCatalog });
