const config = require('../config');
const db = require('../database');

/**
 * Support contact — configurable in admin Settings (DB), falls back to SUPPORT_USERNAME env.
 * Accepts "@name", "name" or a full t.me link.
 */
function getSupportContact() {
    const raw = (db.getSetting('support_username') || config.supportUsername || '').trim();
    const name = raw.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
    return { username: `@${name}`, url: `https://t.me/${name}` };
}

module.exports = { getSupportContact };
