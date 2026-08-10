import { fetchCheckoutCatalog } from '../../_shared/catalog.js';
import { createCartValidationHandler } from '../_cart_validation_handler.js';

export const onRequest = createCartValidationHandler({ fetchCatalog: fetchCheckoutCatalog });
