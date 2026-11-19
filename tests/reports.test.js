const { buildReport, buildCsv } = require('../src/utils/reports');

const row = (o) => ({ order_code: 'A', product_name: 'P', quantity: 1, unit_price: 100, discount_amount: 0,
    total_amount: 100, status: 'delivered', payment_method: 'vietqr', cost_price: 40, day: '2026-11-18',
    created_at: '2026-11-18 10:00:00', paid_at: '2026-11-18 10:01:00', ...o });

describe('reports', () => {
    const rows = [
        row({}),
        row({ order_code: 'B', quantity: 2, total_amount: 180, discount_amount: 20, payment_method: 'usdt', day: '2026-11-19' }),
        row({ order_code: 'C', status: 'expired' }),
    ];
    it('aggregates revenue, profit, methods and periods', () => {
        const r = buildReport(rows, 'day');
        expect(r.summary.revenue).toBe(280);
        expect(r.summary.paidOrders).toBe(2);
        expect(r.summary.expiredOrders).toBe(1);
        expect(r.summary.profit).toBe(280 - 120);
        expect(r.summary.discount).toBe(20);
        expect(r.byMethod.map(m => m.key).sort()).toEqual(['usdt', 'vietqr']);
        expect(r.byPeriod.map(p => p.key)).toEqual(['2026-11-18', '2026-11-19']);
        expect(buildReport(rows, 'month').byPeriod).toHaveLength(1);
    });
    it('builds CSV with BOM and escaping', () => {
        const csv = buildCsv([row({ product_name: 'A, "B"' })]);
        expect(csv.charCodeAt(0)).toBe(0xFEFF);
        expect(csv).toContain('"A, ""B"""');
    });
});
