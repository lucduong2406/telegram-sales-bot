const db = require('../database');
const config = require('../config');
const { CALLBACKS } = require('../handlers/callbacks');
const { deliverCredentials } = require('../handlers/deliveryHandler');

const vnd = (n) => `${Number(n).toLocaleString('vi-VN')} đ`;

function notifyAdmin(bot, text, extra = {}) {
    return bot.sendMessage(config.adminTelegramId, text, extra).catch((err) => {
        console.warn('[Payment] Failed to notify admin:', err.message);
    });
}

function notifyCustomer(bot, order, text) {
    return bot.sendMessage(order.telegram_user_id, text).catch((err) => {
        console.warn(`[Payment] Failed to notify customer ${order.telegram_user_id}:`, err.message);
    });
}

function redeliverKeyboard(orderCode) {
    return {
        reply_markup: {
            inline_keyboard: [[{ text: '🔄 Giao lại', callback_data: `${CALLBACKS.REDELIVER_PREFIX}${orderCode}` }]],
        },
    };
}

/**
 * Handle one incoming bank transfer that carries an order code.
 * Shared by the SePay and GPM Pay webhooks.
 *
 *  - Late payment (order already expired): accepted and delivered if the amount is enough.
 *  - Overpayment: accepted, the extra amount is reported to admin and customer.
 *  - Underpayment / duplicate payment / payment for a cancelled order: nothing is delivered,
 *    admin is told so the money is never silently lost.
 *
 * @param {object} p
 * @param {string} p.orderCode
 * @param {number} p.amount           VND received
 * @param {string} [p.transactionId]  unique id for idempotency
 * @param {string} p.source           label shown to admin ("GPM Pay" / "SePay")
 */
async function processIncomingPayment(bot, { orderCode, amount, transactionId, source }) {
    if (transactionId && db.isTransactionProcessed(transactionId)) {
        console.log(`🔁 ${source}: duplicate transaction ${transactionId}, skipping`);
        return;
    }

    const order = db.getOrderByCode(orderCode);
    if (!order) {
        console.log(`⚠️ ${source}: unknown order ${orderCode}`);
        return;
    }

    const mark = () => { if (transactionId) db.markTransactionProcessed(transactionId, orderCode, amount); };
    const total = Number(order.total_amount);
    const customer = `@${order.telegram_username || order.telegram_user_id}`;
    const summary = `Đơn: #${orderCode}\nSP: ${order.product_name} x${order.quantity}\nKhách: ${customer}`;

    // Already paid — a second transfer for the same order
    if (['paid', 'delivering', 'delivered'].includes(order.status)) {
        mark();
        console.log(`⚠️ ${source}: duplicate payment for ${orderCode} (${order.status})`);
        await notifyAdmin(bot,
            `⚠️ THANH TOÁN TRÙNG (${source})\n\n${summary}\nĐã nhận thêm: ${vnd(amount)}\n\n` +
            `Đơn này đã thanh toán trước đó. Cần hoàn tiền cho khách.`);
        return;
    }

    // Not enough money
    if (amount < total) {
        mark();
        console.log(`⚠️ ${source}: amount mismatch for ${orderCode} — received ${amount}, expected ${total}`);
        await notifyCustomer(bot, order,
            `⚠️ Đơn hàng #${orderCode}: Số tiền nhận được (${vnd(amount)}) chưa đủ (cần ${vnd(total)}).\n` +
            `Vui lòng liên hệ admin để được hỗ trợ.`);
        if (order.status !== 'pending') {
            await notifyAdmin(bot,
                `⚠️ CHUYỂN THIẾU TIỀN (${source}) — đơn ${order.status}\n\n${summary}\n` +
                `Nhận: ${vnd(amount)} / Cần: ${vnd(total)}`);
        }
        return;
    }

    // Customer paid for an order that was cancelled
    if (order.status === 'cancelled') {
        mark();
        await notifyCustomer(bot, order,
            `⚠️ Đơn hàng #${orderCode} đã bị hủy nhưng hệ thống nhận được ${vnd(amount)}.\n` +
            `Admin sẽ liên hệ để xử lý cho bạn.`);
        await notifyAdmin(bot,
            `⚠️ NHẬN TIỀN CHO ĐƠN ĐÃ HỦY (${source})\n\n${summary}\nSố tiền: ${vnd(amount)}\n\n` +
            `Cần xử lý thủ công (xác nhận đơn hoặc hoàn tiền).`);
        return;
    }

    // ✅ Accept — pending, or expired (late payment)
    const wasExpired = order.status === 'expired';
    const extra = amount - total;

    console.log(`✅ ${source}: payment confirmed ${orderCode} (${amount} đ${wasExpired ? ', late' : ''}${extra > 0 ? `, +${extra}` : ''})`);
    db.updateOrderStatus(orderCode, 'paid');
    mark();

    if (order.discount_code) {
        const discountObj = db.getDiscountCodeByCode(order.discount_code);
        if (discountObj) db.useDiscountCode(discountObj.id, order.telegram_user_id, orderCode);
    }

    let confirmText = `✅ Đã xác nhận thanh toán cho đơn hàng #${orderCode}!\n`;
    if (wasExpired) confirmText += `(Đơn đã quá hạn nhưng hệ thống đã nhận được tiền của bạn.)\n`;
    if (extra > 0) {
        confirmText += `\n💡 Bạn đã chuyển dư ${vnd(extra)}. Vui lòng liên hệ admin để được hoàn lại hoặc trừ vào đơn sau.\n`;
    }
    confirmText += `\nĐang gửi thông tin sản phẩm...`;
    await notifyCustomer(bot, order, confirmText);

    try {
        const delivered = await deliverCredentials(bot, db.getOrderByCode(orderCode));
        if (!delivered) {
            console.error(`⚠️ ${source}: deliverCredentials returned false for ${orderCode}`);
            await notifyAdmin(bot,
                `⚠️ GIAO HÀNG THẤT BẠI (${source})\n\n${summary}\n\n` +
                `Kiểm tra kho rồi bấm nút bên dưới để giao lại.`,
                redeliverKeyboard(orderCode));
        }
    } catch (err) {
        console.error(`❌ ${source}: deliverCredentials threw for ${orderCode}:`, err.message);
        await notifyAdmin(bot,
            `❌ LỖI GIAO HÀNG (${source})\n\nĐơn: #${orderCode}\nLỗi: ${err.message}\n\nBấm nút bên dưới để giao lại.`,
            redeliverKeyboard(orderCode));
    }

    let adminText = `💰 Đơn hàng #${orderCode} đã thanh toán qua ${source}!\n` +
        `SP: ${order.product_name} x${order.quantity}\nSố tiền: ${vnd(amount)}\nKhách: ${customer}`;
    if (wasExpired) adminText += `\n⏰ Thanh toán trễ (đơn đã hết hạn) — hệ thống đã tự khôi phục.`;
    if (extra > 0) adminText += `\n💸 Khách chuyển dư ${vnd(extra)} — cần hoàn lại.`;
    await notifyAdmin(bot, adminText);
}

module.exports = { processIncomingPayment };
