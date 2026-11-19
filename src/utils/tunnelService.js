const config = require('../config');
const db = require('../database');
const tunnel = require('./tunnel');
const { registerWebhook } = require('./gpmpayWebhookRegister');

const state = { webhookUrl: null, registeredAt: null, registerError: null };

async function register(url) {
    try {
        const r = await registerWebhook(url);
        state.webhookUrl = r.url;
        state.registeredAt = new Date().toISOString();
        state.registerError = null;
        console.log(`✅ GPM Pay webhook ${r.action}: ${r.url}`);
    } catch (err) {
        state.registerError = err.message;
        throw err;
    }
}

tunnel.setOnUrl(register);

function isEnabled() {
    return db.getSetting('tunnel_enabled') === '1';
}

/** Start the tunnel at boot when the admin left it enabled. Never throws. */
function startIfEnabled() {
    if (isEnabled()) tunnel.start(config.port).catch(() => {});
}

async function setEnabled(enabled) {
    db.setSetting('tunnel_enabled', enabled ? '1' : '0');
    if (enabled) {
        await tunnel.start(config.port);
    } else {
        tunnel.stop();
        state.webhookUrl = null;
        state.registerError = null;
    }
}

/** Re-register the current tunnel URL with GPM Pay. */
async function reregister() {
    const { url } = tunnel.getStatus();
    if (!url) throw new Error('Tunnel chưa chạy');
    await register(url);
}

function getStatus() {
    const t = tunnel.getStatus();
    return {
        enabled: isEnabled(),
        running: t.running,
        starting: t.starting,
        url: t.url,
        webhookUrl: state.webhookUrl,
        registeredAt: state.registeredAt,
        error: state.registerError || t.error,
        hasGpmpayToken: !!config.gpmpayApiToken,
    };
}

module.exports = { startIfEnabled, setEnabled, reregister, getStatus };
