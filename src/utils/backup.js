const fs = require('fs');
const path = require('path');
const db = require('../database');
const config = require('../config');

const BACKUP_DIR = path.join(path.dirname(db.DB_PATH), 'backups');
const PREFIX = 'bot-';

function pad(n) { return String(n).padStart(2, '0'); }

function timestamp(d = new Date()) {
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Snapshot the in-memory database to backups/bot-<timestamp>.db and prune old ones.
 * Uses db.export() so the copy is consistent (not a half-written file).
 * @returns {{file: string, size: number}}
 */
function createBackup() {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `${PREFIX}${timestamp()}.db`);
    const data = Buffer.from(db.getDb().export());
    fs.writeFileSync(file, data);
    pruneBackups();
    return { file, size: data.length };
}

function pruneBackups(keep = config.backupKeep) {
    const files = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith(PREFIX) && f.endsWith('.db'))
        .sort(); // timestamp in name → chronological
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch { /* ignore */ }
    }
}

/**
 * Periodic backups (BACKUP_INTERVAL_HOURS, default 6; keeps BACKUP_KEEP, default 28).
 * Once a day the latest backup is also sent to the admin on Telegram,
 * so a copy exists off the server.
 */
function startBackupScheduler(bot) {
    const intervalMs = config.backupIntervalHours * 60 * 60 * 1000;
    let lastSentDay = null;

    const run = async () => {
        try {
            const { file, size } = createBackup();
            console.log(`💾 Database backup: ${file} (${(size / 1024).toFixed(0)} KB)`);

            const today = new Date().toDateString();
            if (bot && lastSentDay !== today) {
                await bot.sendDocument(config.adminTelegramId, file, {
                    caption: `💾 Sao lưu database ${new Date().toLocaleString('vi-VN')}`,
                }).then(() => { lastSentDay = today; })
                  .catch((err) => console.warn('[Backup] Failed to send to admin:', err.message));
            }
        } catch (err) {
            console.error('❌ Database backup failed:', err.message);
        }
    };

    setTimeout(run, 60 * 1000);
    setInterval(run, intervalMs);
    console.log(`💾 Backup scheduler started (every ${config.backupIntervalHours}h, keep ${config.backupKeep})`);
}

module.exports = { createBackup, pruneBackups, startBackupScheduler, BACKUP_DIR };
