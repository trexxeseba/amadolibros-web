import { createMpWebhookHandler } from '../_mp_webhook_handler.js';

const handler = createMpWebhookHandler();
export const onRequest = handler;
