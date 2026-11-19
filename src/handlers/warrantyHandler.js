const db = require('../database');
const config = require('../config');
const { CALLBACKS } = require('./callbacks');
const { getLang } = require('../locales');
const { getSupportContact } = require('../utils/support');
const { getWarrantyStatus, REASONS } = require('../utils/warranty');

const L = (lang, vi, en) => (lang === 'en' ? en : vi);

function setupWarrantyHandler(bot) {
    bot.on('callback_query', async (query) => {
        const data = query.data || '';
        const answer = (text) => bot.answerCallbackQuery(query.id, text ? { text } : {}).catch(() => {});
        const chatId = query.message && query.message.chat.id;
        const msgId = query.message && query.message.message_id;

        // Customer: list orders eligible for warranty
        if (data === CALLBACKS.WARRANTY_MENU) {
            const lang = getLang(query.from.id, db.getUserLanguage);
            answer();
            const rows = [];
            for (const o of db.getUserOrders(query.from.id, 50)) {
                if (o.status !== 'delivered') continue;
                const st = getWarrantyStatus(o, db.getProductById(o.product_id));
                if (!st.active) continue;
                rows.push([{ text: `🛡 #${o.order_code} | ${o.product_name} | ${st.daysLeft}d`,
                    callback_data: `${CALLBACKS.WARRANTY_NEW_PREFIX}${o.order_code}` }]);
            }
            rows.push([{ text: L(lang, '🏠 Menu chính', '🏠 Main menu'), callback_data: CALLBACKS.MENU_MAIN }]);
            const text = rows.length > 1
                ? L(lang, '🛡 *Chọn đơn cần bảo hành:*', '🛡 *Choose an order for warranty:*')
                : L(lang, '🛡 Bạn chưa có đơn nào còn thời hạn bảo hành.', '🛡 You have no orders under warranty.');
            bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }).catch(() => {});
            return;
        }

        // Customer: open reason picker
        if (data.startsWith(CALLBACKS.WARRANTY_NEW_PREFIX)) {
            const code = data.slice(CALLBACKS.WARRANTY_NEW_PREFIX.length);
            const lang = getLang(query.from.id, db.getUserLanguage);
            const order = db.getOrderByCode(code);
            if (!order || order.telegram_user_id !== query.from.id) return answer('❌');
            const st = getWarrantyStatus(order, db.getProductById(order.product_id));
            if (!st.active) return answer(L(lang, '⚠️ Đơn không còn trong thời hạn bảo hành', '⚠️ Warranty not active'));
            if (db.getOpenWarrantyClaim(code)) return answer(L(lang, '⏳ Yêu cầu bảo hành đang được xử lý', '⏳ A claim is already open'));
            answer();
            const rows = Object.entries(REASONS).map(([k, v]) =>
                [{ text: v[lang] || v.vi, callback_data: `${CALLBACKS.WARRANTY_REASON_PREFIX}${k}_${code}` }]);
            rows.push([{ text: L(lang, '⬅️ Quay lại', '⬅️ Back'), callback_data: `${CALLBACKS.ORDER_VIEW_PREFIX}${code}` }]);
            bot.editMessageText(L(lang, `🛡 *Bảo hành đơn #${code}*\nChọn vấn đề bạn gặp:`, `🛡 *Warranty for #${code}*\nChoose your issue:`),
                { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }).catch(() => {});
            return;
        }

        // Customer: submit claim
        if (data.startsWith(CALLBACKS.WARRANTY_REASON_PREFIX)) {
            const [key, ...rest] = data.slice(CALLBACKS.WARRANTY_REASON_PREFIX.length).split('_');
            const code = rest.join('_');
            const lang = getLang(query.from.id, db.getUserLanguage);
            const order = db.getOrderByCode(code);
            if (!order || order.telegram_user_id !== query.from.id || !REASONS[key]) return answer('❌');
            const product = db.getProductById(order.product_id);
            const st = getWarrantyStatus(order, product);
            if (!st.active) return answer(L(lang, '⚠️ Đơn không còn trong thời hạn bảo hành', '⚠️ Warranty not active'));
            if (db.getOpenWarrantyClaim(code)) return answer(L(lang, '⏳ Yêu cầu bảo hành đang được xử lý', '⏳ A claim is already open'));

            const reason = REASONS[key].vi;
            const id = db.createWarrantyClaim(code, query.from.id, reason);
            answer('✅');
            bot.editMessageText(L(lang,
                `✅ Đã gửi yêu cầu bảo hành đơn #${code}.\nAdmin sẽ phản hồi sớm nhất.`,
                `✅ Warranty claim for #${code} sent.\nWe will get back to you soon.`),
                { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [
                    [{ text: L(lang, '💬 Liên hệ hỗ trợ', '💬 Contact support'), url: getSupportContact().url }],
                    [{ text: L(lang, '🏠 Menu chính', '🏠 Main menu'), callback_data: CALLBACKS.MENU_MAIN }]] } }).catch(() => {});

            const who = order.telegram_username ? `@${order.telegram_username}` : order.telegram_user_id;
            bot.sendMessage(config.adminTelegramId,
                `🛡 YÊU CẦU BẢO HÀNH #${id}\n\n🆔 Đơn: #${code}\n📦 SP: ${order.product_name} x${order.quantity}\n👤 Khách: ${who}\n` +
                `❗ Lý do: ${reason}\n⏳ Còn bảo hành: ${st.daysLeft} ngày`,
                { reply_markup: { inline_keyboard: [[
                    { text: '✅ Đã xử lý', callback_data: `${CALLBACKS.WARRANTY_OK_PREFIX}${id}` },
                    { text: '❌ Từ chối', callback_data: `${CALLBACKS.WARRANTY_NO_PREFIX}${id}` }]] } }).catch(() => {});
            return;
        }

        // Admin: resolve / reject
        const isOk = data.startsWith(CALLBACKS.WARRANTY_OK_PREFIX);
        if (isOk || data.startsWith(CALLBACKS.WARRANTY_NO_PREFIX)) {
            if (query.from.id !== config.adminTelegramId) return answer('⛔ Chỉ admin');
            const id = parseInt(data.slice((isOk ? CALLBACKS.WARRANTY_OK_PREFIX : CALLBACKS.WARRANTY_NO_PREFIX).length));
            const claim = db.getWarrantyClaim(id);
            if (!claim) return answer('❌ Không tìm thấy');
            if (claim.status !== 'open') return answer('Đã xử lý trước đó');
            db.resolveWarrantyClaim(id, isOk ? 'resolved' : 'rejected');
            answer('OK');
            bot.editMessageText(`${query.message.text}\n\n${isOk ? '✅ ĐÃ XỬ LÝ' : '❌ ĐÃ TỪ CHỐI'}`,
                { chat_id: chatId, message_id: msgId }).catch(() => {});
            const lang = getLang(claim.telegram_user_id, db.getUserLanguage);
            bot.sendMessage(claim.telegram_user_id, isOk
                ? L(lang, `✅ Yêu cầu bảo hành đơn #${claim.order_code} đã được xử lý.`, `✅ Your warranty claim for #${claim.order_code} has been handled.`)
                : L(lang, `❌ Yêu cầu bảo hành đơn #${claim.order_code} bị từ chối. Vui lòng liên hệ hỗ trợ để biết thêm.`, `❌ Your warranty claim for #${claim.order_code} was declined. Please contact support.`),
                { reply_markup: { inline_keyboard: [[{ text: L(lang, '💬 Liên hệ hỗ trợ', '💬 Contact support'), url: getSupportContact().url }]] } }).catch(() => {});
        }
    });
}

module.exports = { setupWarrantyHandler };
