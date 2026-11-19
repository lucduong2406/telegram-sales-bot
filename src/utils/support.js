const config = require('../config');
const db = require('../database');
const { t } = require('../locales');

/**
 * Support contact — configurable in admin Settings (DB), falls back to SUPPORT_USERNAME env.
 * Accepts "@name", "name" or a full t.me link.
 */
function getSupportContact() {
    const raw = (db.getSetting('support_username') || config.supportUsername || '').trim();
    const name = raw.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
    return { username: `@${name}`, url: `https://t.me/${name}` };
}

/**
 * "Không đủ hàng!" message followed by a second message with a Contact Admin button.
 */
function sendInsufficientStock(bot, chatId, lang, { name, requested, available }) {
    return bot.sendMessage(chatId, t('order_insufficient_stock', lang, { name, requested, available }))
        .then(() => bot.sendMessage(chatId, t('insufficient_stock_contact', lang), {
            reply_markup: { inline_keyboard: [[{ text: t('btn_contact_admin', lang), url: getSupportContact().url }]] },
        }))
        .catch((err) => console.warn('[Stock] Failed to send insufficient-stock message:', err.message));
}

module.exports = { getSupportContact, sendInsufficientStock };
