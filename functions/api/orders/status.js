import { createOrderStatusHandler } from '../_order_status_handler.js';

const handler = createOrderStatusHandler();
export const onRequest = handler;
