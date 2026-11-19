/**
 * Telegram custom-emoji icons on inline buttons (Bot API: icon_custom_emoji_id).
 * Only works if the bot owner has Premium / bot has Fragment username;
 * otherwise Telegram rejects the markup, so callers retry with stripIcons().
 */
function withIcon(button, customEmojiId) {
    return customEmojiId ? { ...button, icon_custom_emoji_id: customEmojiId } : button;
}

function stripIcons(replyMarkup) {
    if (!replyMarkup || !replyMarkup.inline_keyboard) return replyMarkup;
    return {
        ...replyMarkup,
        inline_keyboard: replyMarkup.inline_keyboard.map(row =>
            row.map(({ icon_custom_emoji_id, ...btn }) => btn)),
    };
}

function hasIcons(replyMarkup) {
    return !!(replyMarkup && replyMarkup.inline_keyboard &&
        replyMarkup.inline_keyboard.some(row => row.some(b => b.icon_custom_emoji_id)));
}

/** Run send(markup); if it fails and markup has custom icons, retry without them. */
async function withIconFallback(markup, send) {
    try {
        return await send(markup);
    } catch (err) {
        if (!hasIcons(markup)) throw err;
        console.warn('[CustomEmoji] rejected, retrying without icons:', err.message);
        return send(stripIcons(markup));
    }
}

module.exports = { withIcon, stripIcons, hasIcons, withIconFallback };
