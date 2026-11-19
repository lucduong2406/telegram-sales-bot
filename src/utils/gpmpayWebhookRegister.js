const config = require('../config');
const db = require('../database');
const { getGpmPayClient } = require('./gpmpay');

const ENDPOINT_NAME = 'telegram-sales-bot';
const WEBHOOK_PATH = '/webhook/gpmpay';

/** Secret used to verify incoming webhooks: env wins, then the one we stored. */
function getWebhookSecret() {
    return config.gpmpayWebhookSecret || db.getSetting('gpmpay_webhook_secret') || null;
}

function friendlyError(err) {
    const msg = err && err.message ? err.message : String(err);
    if (/GPMPAY_API_TOKEN/.test(msg)) return 'Chưa cấu hình GPMPAY_API_TOKEN trong .env';
    if (err && (err.status === 403 || /permission|scope/i.test(msg))) {
        return 'API token thiếu quyền webhooks:manage — tạo lại token tại app.gpmpay.com/api-tokens';
    }
    return msg;
}

/**
 * Register (or update) the HMAC webhook endpoint at GPM Pay for `publicUrl`.
 * GPM Pay pings the URL before saving, so the tunnel + server must already be up.
 * The signing secret is only returned on creation — we persist it in settings.
 */
async function registerWebhook(publicUrl, client = null) {
    const url = publicUrl.replace(/\/+$/, '') + WEBHOOK_PATH;
    try {
        client = client || getGpmPayClient();
        const page = await client.webhookSettings.list();
        const items = Array.isArray(page) ? page : (page.data || page.items || []);
        const existing = items.find((s) => s.name === ENDPOINT_NAME);
        const haveSecret = !!getWebhookSecret();

        if (existing && haveSecret) {
            if (existing.url !== url) await client.webhookSettings.update(existing.id, { url });
            return { url, action: existing.url !== url ? 'updated' : 'unchanged' };
        }

        // Missing endpoint, or we lost its secret (shown once) → recreate.
        if (existing) await client.webhookSettings.remove(existing.id);
        const { secret } = await client.webhookSettings.createHmacEndpoint({ url, name: ENDPOINT_NAME });
        db.setSetting('gpmpay_webhook_secret', secret);
        return { url, action: 'created' };
    } catch (err) {
        throw new Error(friendlyError(err));
    }
}

module.exports = { registerWebhook, getWebhookSecret, ENDPOINT_NAME, WEBHOOK_PATH };
