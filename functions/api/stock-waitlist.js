import { fetchCatalog, fetchPausedItem } from '../_shared/catalog.js';
import { createStockWaitlistHandler } from './_stock_waitlist_handler.js';

export const onRequest = createStockWaitlistHandler({ fetchCatalog, fetchPausedItem });
