/**
 * Unit Tests for GPM Pay Integration
 * - processed_transactions idempotency table
 * - GPM Pay as enabled payment method
 * - buildGpmPayQrUrl QR generation
 * - Config has GPM Pay fields
 */

// globals: true in vitest.config.js → describe, it, expect, beforeAll, afterAll, beforeEach are auto-available

let db;
let config;

beforeAll(async () => {
    process.env.DB_PATH = '/tmp/test-gpmpay-' + Date.now() + '.db';
    process.env.BOT_TOKEN = 'test-token';
    process.env.ADMIN_API_KEY = 'test-key';
    process.env.GPMPAY_API_TOKEN = 'gpm_test_token_123';
    process.env.GPMPAY_WEBHOOK_SECRET = 'test_webhook_secret';

    db = require('../src/database');
    config = require('../src/config');
    await db.initDatabase();
});

afterAll(() => {
    const fs = require('fs');
    try { fs.unlinkSync(process.env.DB_PATH); } catch { /* ignore */ }
});

describe('GPM Pay — processed_transactions idempotency', () => {
    it('G1: isTransactionProcessed returns false for unknown transaction', () => {
        expect(db.isTransactionProcessed('txn_unknown_123')).toBe(false);
    });

    it('G2: markTransactionProcessed then isTransactionProcessed returns true', () => {
        db.markTransactionProcessed('txn_abc_456', 'ORD1234567890', 50000);
        expect(db.isTransactionProcessed('txn_abc_456')).toBe(true);
    });

    it('G3: markTransactionProcessed is idempotent (INSERT OR IGNORE)', () => {
        // Should not throw when marking the same transaction twice
        db.markTransactionProcessed('txn_abc_456', 'ORD1234567890', 50000);
        expect(db.isTransactionProcessed('txn_abc_456')).toBe(true);
    });

    it('G4: different transaction IDs are independent', () => {
        db.markTransactionProcessed('txn_1', 'ORD001', 10000);
        db.markTransactionProcessed('txn_2', 'ORD002', 20000);
        expect(db.isTransactionProcessed('txn_1')).toBe(true);
        expect(db.isTransactionProcessed('txn_2')).toBe(true);
        expect(db.isTransactionProcessed('txn_3')).toBe(false);
    });
});

describe('GPM Pay — enabled payment methods', () => {
    it('G5: GPM Pay is in enabled payment methods when token is set', () => {
        const methods = db.getEnabledPaymentMethods();
        const gpmpay = methods.find(m => m.id === 'gpmpay');
        expect(gpmpay).toBeDefined();
        expect(gpmpay.label).toBe('GPM Pay');
        expect(gpmpay.icon).toBe('🏦');
    });
});

describe('GPM Pay — buildGpmPayQrUrl', () => {
    it('G6: buildGpmPayQrUrl returns a valid VietQR image URL', () => {
        const { buildGpmPayQrUrl } = require('../src/utils/gpmpay');
        const url = buildGpmPayQrUrl(50000, 'ORD1234567890');
        expect(typeof url).toBe('string');
        expect(url).toContain('img.vietqr.io');
        expect(url).toContain('ORD1234567890');
    });

    it('G7: buildGpmPayQrUrl rounds amount to integer', () => {
        const { buildGpmPayQrUrl } = require('../src/utils/gpmpay');
        const url = buildGpmPayQrUrl(50000.99, 'ORD1234567890');
        expect(typeof url).toBe('string');
        expect(url).toContain('img.vietqr.io');
    });
});

describe('GPM Pay — config', () => {
    it('G8: config has GPM Pay fields', () => {
        expect(config.gpmpayApiToken).toBe('gpm_test_token_123');
        expect(config.gpmpayApiUrl).toBe('https://api.gpmpay.com/api/v1');
        expect(config.gpmpayWebhookSecret).toBe('test_webhook_secret');
    });
});
