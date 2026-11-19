const { getWarrantyStatus } = require('../src/utils/warranty');
const db = require('../src/database');

describe('warranty status', () => {
    const now = new Date('2026-11-19T00:00:00Z');
    const product = { warranty_days: 30 };
    it('active within window', () => {
        const s = getWarrantyStatus({ status: 'delivered', delivered_at: '2026-11-10T00:00:00Z' }, product, now);
        expect(s.active).toBe(true);
        expect(s.daysLeft).toBe(21);
    });
    it('expired after window', () => {
        expect(getWarrantyStatus({ status: 'delivered', delivered_at: '2026-09-01T00:00:00Z' }, product, now).active).toBe(false);
    });
    it('no warranty / undelivered', () => {
        expect(getWarrantyStatus({ status: 'delivered' }, { warranty_days: null }, now).hasWarranty).toBe(false);
        expect(getWarrantyStatus({ status: 'paid' }, product, now).active).toBe(false);
    });
});

describe('warranty claims', () => {
    beforeAll(async () => { await db.initDatabase(); });
    it('blocks duplicates while open and resolves once', () => {
        const id = db.createWarrantyClaim('WTEST1', 1, 'Sai mật khẩu');
        expect(db.getOpenWarrantyClaim('WTEST1').id).toBe(id);
        db.resolveWarrantyClaim(id, 'resolved');
        expect(db.getOpenWarrantyClaim('WTEST1')).toBeNull();
        expect(db.getWarrantyClaim(id).status).toBe('resolved');
    });
});
