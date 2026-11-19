const express = require('express');
const config = require('../config');
const { constructWebhookEvent } = require('@gpmpay/sdk/webhooks');
const { processIncomingPayment } = require('../utils/paymentProcessor');

/**
 * Setup Express route for GPM Pay webhook.
 * GPM Pay sends HMAC-signed webhooks for every incoming bank transfer.
 * Raw body parser is required BEFORE express.json() for signature verification.
 */
function setupGpmPayWebhookHandler(app, bot) {
    app.post('/webhook/gpmpay', express.raw({ type: 'application/json' }), async (req, res) => {
        try {
            if (!config.gpmpayWebhookSecret) {
                console.error('❌ GPM Pay: GPMPAY_WEBHOOK_SECRET not set');
                res.status(500).json({ error: 'Webhook secret not configured' });
                return;
            }

            const signature = req.headers['x-gpmpay-signature'];
            if (!signature) {
                res.status(401).json({ error: 'Missing signature' });
                return;
            }

            // Verify HMAC signature — req.body is a Buffer from express.raw()
            let event;
            try {
                event = constructWebhookEvent({
                    rawBody: req.body,
                    signature,
                    secret: config.gpmpayWebhookSecret,
                });
            } catch (sigErr) {
                console.warn('⚠️ GPM Pay: Invalid webhook signature:', sigErr.message);
                res.status(401).json({ error: 'Invalid signature' });
                return;
            }

            const payload = event.payload;

            // Skip test/ping payloads (sent when registering webhook endpoint)
            if ('test' in payload) {
                console.log('🏓 GPM Pay: Skipped test/ping payload');
                res.json({ success: true });
                return;
            }

            // Only process incoming transfers
            if (payload.transferType !== 'in') {
                res.json({ success: true });
                return;
            }

            const transactionId = payload.id;
            const content = payload.content || '';
            const amount = payload.transferAmount;

            console.log(`📥 GPM Pay webhook: ${payload.transferType} ${amount} — content: ${content}`);

            // Extract order code from transfer content (e.g. "ORD17123456789012345")
            const orderCodeMatch = content.match(/ORD\d{13,20}/);
            if (!orderCodeMatch) {
                console.log('⚠️ GPM Pay: No order code found in content');
                res.json({ success: true });
                return;
            }

            // Idempotent (by payload.id), handles late payment / overpayment / duplicates
            await processIncomingPayment(bot, {
                orderCode: orderCodeMatch[0],
                amount,
                transactionId,
                source: 'GPM Pay',
            });

            res.json({ success: true });
        } catch (err) {
            console.error('❌ GPM Pay webhook error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    console.log('📡 GPM Pay webhook listening at POST /webhook/gpmpay');
}

module.exports = { setupGpmPayWebhookHandler };
