const { withIcon, stripIcons, withIconFallback } = require('../src/utils/customEmoji');

describe('custom emoji icons', () => {
    it('adds and strips icon_custom_emoji_id', () => {
        const b = withIcon({ text: 'X', callback_data: 'a' }, '123456');
        expect(b.icon_custom_emoji_id).toBe('123456');
        expect(withIcon({ text: 'X' }, null)).toEqual({ text: 'X' });
        const m = stripIcons({ inline_keyboard: [[b]] });
        expect(m.inline_keyboard[0][0]).toEqual({ text: 'X', callback_data: 'a' });
    });
    it('retries without icons when Telegram rejects', async () => {
        const markup = { inline_keyboard: [[{ text: 'X', icon_custom_emoji_id: '123456' }]] };
        const calls = [];
        await withIconFallback(markup, async (m) => {
            calls.push(m);
            if (calls.length === 1) throw new Error('400 bad request');
        });
        expect(calls).toHaveLength(2);
        expect(calls[1].inline_keyboard[0][0].icon_custom_emoji_id).toBeUndefined();
    });
});
