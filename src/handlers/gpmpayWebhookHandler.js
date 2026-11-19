const express = require('express');
const db = require('../database');
const config = require('../config');
const { constructWebhookEvent } = require('@gpmpay/sdk/webhooks');
const { deliverCredentials } = require('./deliveryHandler');

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

            // Idempotency: skip already processed transactions
            // GPM Pay retries up to 6 times (10s, 30s, 2m, 10m, 1h, 6h)
            if (db.isTransactionProcessed(transactionId)) {
                console.log(`🔁 GPM Pay: Duplicate transaction ${transactionId}, skipping`);
                res.json({ success: true });
                return;
            }

            // Extract order code from transfer content (e.g. "ORD17123456789012345")
            const orderCodeMatch = content.match(/ORD\d{13,20}/);
            if (!orderCodeMatch) {
                console.log('⚠️ GPM Pay: No order code found in content');
                res.json({ success: true });
                return;
            }
            const orderCode = orderCodeMatch[0];

            // Find pending order
            const order = db.getPendingOrderByCode(orderCode);
            if (!order) {
                console.log(`⚠️ GPM Pay: No pending order: ${orderCode}`);
                res.json({ success: true });
                return;
            }

            // Verify amount — must match exactly (integer VND)
            if (amount !== order.total_amount) {
                console.log(
                    `⚠️ GPM Pay: Amount mismatch for ${orderCode} — ` +
                    `received ${amount}, expected ${order.total_amount}`
                );

                // Mark as processed to avoid reprocessing underpayment
                db.markTransactionProcessed(transactionId, orderCode, amount);

                bot.sendMessage(order.telegram_user_id,
                    `⚠️ Đơn hàng #${orderCode}: Số tiền nhận được (${amount.toLocaleString('vi-VN')} đ) ` +
                    `chưa đủ (cần ${order.total_amount.toLocaleString('vi-VN')} đ).\n` +
                    `Vui lòng chuyển thêm hoặc liên hệ admin.`
                ).catch(() => {});

                res.json({ success: true });
                return;
            }

            // ✅ Payment confirmed!
            console.log(`✅ GPM Pay: Payment confirmed: ${orderCode} (${amount} đ)`);
            db.updateOrderStatus(orderCode, 'paid');
            db.markTransactionProcessed(transactionId, orderCode, amount);

            // Record discount usage on successful payment
            if (order.discount_code) {
                const discountObj = db.getDiscountCodeByCode(order.discount_code);
                if (discountObj) {
                    db.useDiscountCode(discountObj.id, order.telegram_user_id, orderCode);
                }
            }

            // Notify user
            await bot.sendMessage(order.telegram_user_id,
                `✅ Đã xác nhận thanh toán cho đơn hàng #${orderCode}!\n\n` +
                `Đang gửi thông tin sản phẩm...`
            );

            // Deliver credentials with robust error handling
            try {
                const delivered = await deliverCredentials(bot, order);
                if (!delivered) {
                    console.error(`⚠️ GPM Pay: deliverCredentials returned false for ${orderCode}`);
                    bot.sendMessage(config.adminTelegramId,
                        `⚠️ **GIAO HÀNG THẤT BẠI** (GPM Pay)\n\n` +
                        `Đơn: #${orderCode}\n` +
                        `SP: ${order.product_name} x${order.quantity}\n` +
                        `Khách: @${order.telegram_username || order.telegram_user_id}\n\n` +
                        `Vui lòng kiểm tra stock và giao thủ công.`,
                        { parse_mode: 'Markdown' }
                    ).catch(() => {});
                }
            } catch (deliveryErr) {
                console.error(`❌ GPM Pay: deliverCredentials threw for ${orderCode}:`, deliveryErr.message);
                bot.sendMessage(config.adminTelegramId,
                    `❌ **LỖI GIAO HÀNG** (GPM Pay)\n\n` +
                    `Đơn: #${orderCode}\nLỗi: ${deliveryErr.message}\n\n` +
                    `Vui lòng giao thủ công.`,
                    { parse_mode: 'Markdown' }
                ).catch(() => {});
            }

            // Notify admin about payment
            bot.sendMessage(config.adminTelegramId,
                `💰 Đơn hàng #${orderCode} đã thanh toán qua **GPM Pay**!\n` +
                `SP: ${order.product_name} x${order.quantity}\n` +
                `Số tiền: ${amount.toLocaleString('vi-VN')} đ\n` +
                `Khách: @${order.telegram_username || order.telegram_user_id}`
            ).catch((err) => {
                console.warn('[GPM Pay Webhook] Failed to notify admin:', err.message);
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
