const { parseTunnelUrl } = require('../src/utils/tunnel');
const db = require('../src/database');
const config = require('../src/config');
const { registerWebhook, getWebhookSecret } = require('../src/utils/gpmpayWebhookRegister');

describe('parseTunnelUrl', () => {
    it('extracts quick tunnel URL from cloudflared log', () => {
        const log = '2026-11-19T10:00:00Z INF |  https://random-words-here-1234.trycloudflare.com  |\n';
        expect(parseTunnelUrl(log)).toBe('https://random-words-here-1234.trycloudflare.com');
    });
    it('returns null when no URL yet', () => {
        expect(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
        expect(parseTunnelUrl('')).toBeNull();
    });
});

function mockClient({ items = [], secret = 'sec123' } = {}) {
    return {
        webhookSettings: {
            list: vi.fn().mockResolvedValue({ data: items }),
            update: vi.fn().mockResolvedValue({}),
            remove: vi.fn().mockResolvedValue({}),
            createHmacEndpoint: vi.fn().mockResolvedValue({ setting: {}, secret }),
        },
    };
}

describe('registerWebhook', () => {
    beforeAll(async () => { await db.initDatabase(); });
    beforeEach(() => { db.setSetting('gpmpay_webhook_secret', ''); config.gpmpayWebhookSecret = undefined; });

    it('creates endpoint and stores the one-time secret', async () => {
        const c = mockClient();
        const r = await registerWebhook('https://a.trycloudflare.com/', c);
        expect(r).toEqual({ url: 'https://a.trycloudflare.com/webhook/gpmpay', action: 'created' });
        expect(c.webhookSettings.createHmacEndpoint).toHaveBeenCalledWith({ url: r.url, name: 'telegram-sales-bot' });
        expect(getWebhookSecret()).toBe('sec123');
    });

    it('updates url when endpoint exists and secret is known', async () => {
        db.setSetting('gpmpay_webhook_secret', 'known');
        const c = mockClient({ items: [{ id: 'w1', name: 'telegram-sales-bot', url: 'https://old.trycloudflare.com/webhook/gpmpay' }] });
        const r = await registerWebhook('https://new.trycloudflare.com', c);
        expect(r.action).toBe('updated');
        expect(c.webhookSettings.update).toHaveBeenCalledWith('w1', { url: 'https://new.trycloudflare.com/webhook/gpmpay' });
        expect(c.webhookSettings.createHmacEndpoint).not.toHaveBeenCalled();
    });

    it('recreates endpoint when the secret was lost', async () => {
        const c = mockClient({ items: [{ id: 'w1', name: 'telegram-sales-bot', url: 'x' }], secret: 'fresh' });
        const r = await registerWebhook('https://n.trycloudflare.com', c);
        expect(r.action).toBe('created');
        expect(c.webhookSettings.remove).toHaveBeenCalledWith('w1');
        expect(getWebhookSecret()).toBe('fresh');
    });

    it('env secret takes priority over stored', () => {
        db.setSetting('gpmpay_webhook_secret', 'stored');
        config.gpmpayWebhookSecret = 'fromenv';
        expect(getWebhookSecret()).toBe('fromenv');
    });

    it('maps permission errors to a friendly message', async () => {
        const c = mockClient();
        c.webhookSettings.list.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
        await expect(registerWebhook('https://n.trycloudflare.com', c)).rejects.toThrow(/webhooks:manage/);
    });
});
