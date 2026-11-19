const { parseTunnelUrl, waitUntilReachable } = require('../src/utils/tunnel');
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

describe('waitUntilReachable', () => {
    it('retries past 404s until the tunnel answers', async () => {
        const f = vi.fn()
            .mockResolvedValueOnce({ ok: false, status: 404 })
            .mockRejectedValueOnce(new Error('ENOTFOUND'))
            .mockResolvedValueOnce({ ok: true });
        expect(await waitUntilReachable('https://a.trycloudflare.com', { fetchFn: f, attempts: 5, delayMs: 1 })).toBe(true);
        expect(f).toHaveBeenCalledTimes(3);
    });
    it('gives up after the attempt limit', async () => {
        const f = vi.fn().mockResolvedValue({ ok: false, status: 404 });
        expect(await waitUntilReachable('https://a.trycloudflare.com', { fetchFn: f, attempts: 3, delayMs: 1 })).toBe(false);
        expect(f).toHaveBeenCalledTimes(3);
    });
});

function mockClient({ items = [] } = {}) {
    return {
        webhookSettings: {
            list: vi.fn().mockResolvedValue({ data: items }),
            update: vi.fn().mockResolvedValue({}),
            remove: vi.fn().mockResolvedValue({}),
            // Records whether the secret was already stored when GPM Pay "pings" during create
            createHmacEndpoint: vi.fn().mockImplementation(async (p) => ({
                setting: { storedAtPing: getWebhookSecret() === p.secret }, secret: p.secret,
            })),
        },
    };
}

describe('registerWebhook', () => {
    beforeAll(async () => { await db.initDatabase(); });
    beforeEach(() => { db.setSetting('gpmpay_webhook_secret', ''); config.gpmpayWebhookSecret = undefined; });

    it('stores the secret BEFORE creating so the ping can be verified', async () => {
        const c = mockClient();
        const r = await registerWebhook('https://a.trycloudflare.com/', c);
        expect(r).toEqual({ url: 'https://a.trycloudflare.com/webhook/gpmpay', action: 'created' });
        const arg = c.webhookSettings.createHmacEndpoint.mock.calls[0][0];
        expect(arg).toMatchObject({ url: r.url, name: 'telegram-sales-bot' });
        expect(arg.secret).toMatch(/^[0-9a-f]{64}$/);
        const res = await c.webhookSettings.createHmacEndpoint.mock.results[0].value;
        expect(res.setting.storedAtPing).toBe(true);
        expect(getWebhookSecret()).toBe(arg.secret);
    });

    it('rolls back the stored secret when creation fails', async () => {
        const c = mockClient();
        c.webhookSettings.createHmacEndpoint.mockRejectedValue(new Error('boom'));
        await expect(registerWebhook('https://a.trycloudflare.com', c)).rejects.toThrow('boom');
        expect(getWebhookSecret()).toBeFalsy();
    });

    it('uses the env secret for creation when set', async () => {
        config.gpmpayWebhookSecret = 'fromenv';
        const c = mockClient();
        await registerWebhook('https://a.trycloudflare.com', c);
        expect(c.webhookSettings.createHmacEndpoint.mock.calls[0][0].secret).toBe('fromenv');
        expect(db.getSetting('gpmpay_webhook_secret')).toBeFalsy();
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
        const c = mockClient({ items: [{ id: 'w1', name: 'telegram-sales-bot', url: 'x' }] });
        const r = await registerWebhook('https://n.trycloudflare.com', c);
        expect(r.action).toBe('created');
        expect(c.webhookSettings.remove).toHaveBeenCalledWith('w1');
        expect(getWebhookSecret()).toBe(c.webhookSettings.createHmacEndpoint.mock.calls[0][0].secret);
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
