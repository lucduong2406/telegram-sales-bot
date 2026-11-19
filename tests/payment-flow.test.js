let db, processIncomingPayment, createBackup, BACKUP_DIR;
const sent = [];
const bot = { sendMessage: async (id, text, opts) => { sent.push({ id, text, opts }); }, sendDocument: async () => {} };

beforeAll(async () => {
    process.env.DB_PATH = '/tmp/test-payflow-' + Date.now() + '/bot.db';
    process.env.BOT_TOKEN = 'test-token';
    process.env.ADMIN_API_KEY = 'k';
    process.env.ADMIN_TELEGRAM_ID = '999';
    db = require('../src/database');
    await db.initDatabase();
    ({ processIncomingPayment } = require('../src/utils/paymentProcessor'));
    ({ createBackup, BACKUP_DIR } = require('../src/utils/backup'));
});

function newOrder(status, total = 50000) {
    const pid = db.addProduct('P' + Math.random(), total, '', '');
    db.addCredential(pid, { username: 'u', password: 'p' });
    const code = db.createOrder({
        telegramUserId: 1, telegramUsername: 'x', productId: pid, productName: 'P', quantity: 1,
        unitPrice: total, totalAmount: total, qrUrl: '', expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    if (status !== 'pending') db.updateOrderStatus(code, status);
    return code;
}

describe('payment processor', () => {
    beforeEach(() => { sent.length = 0; });

    it('P1: late payment on expired order is accepted', async () => {
        const code = newOrder('expired');
        await processIncomingPayment(bot, { orderCode: code, amount: 50000, transactionId: 't1', source: 'T' });
        expect(['paid', 'delivering', 'delivered']).toContain(db.getOrderByCode(code).status);
        expect(sent.some((m) => m.text.includes('quá hạn'))).toBe(true);
    });

    it('P2: overpayment is accepted and reported', async () => {
        const code = newOrder('pending');
        await processIncomingPayment(bot, { orderCode: code, amount: 70000, transactionId: 't2', source: 'T' });
        expect(db.getOrderByCode(code).status).not.toBe('pending');
        expect(sent.some((m) => m.text.includes('chuyển dư'))).toBe(true);
    });

    it('P3: underpayment is not accepted', async () => {
        const code = newOrder('pending');
        await processIncomingPayment(bot, { orderCode: code, amount: 10000, transactionId: 't3', source: 'T' });
        expect(db.getOrderByCode(code).status).toBe('pending');
    });

    it('P4: second transfer for a paid order alerts admin, no re-delivery', async () => {
        const code = newOrder('pending');
        await processIncomingPayment(bot, { orderCode: code, amount: 50000, transactionId: 't4a', source: 'T' });
        sent.length = 0;
        await processIncomingPayment(bot, { orderCode: code, amount: 50000, transactionId: 't4b', source: 'T' });
        expect(sent.some((m) => m.text.includes('THANH TOÁN TRÙNG'))).toBe(true);
    });

    it('P5: same transaction id is processed once', async () => {
        const code = newOrder('pending');
        await processIncomingPayment(bot, { orderCode: code, amount: 50000, transactionId: 't5', source: 'T' });
        sent.length = 0;
        await processIncomingPayment(bot, { orderCode: code, amount: 50000, transactionId: 't5', source: 'T' });
        expect(sent.length).toBe(0);
    });

    it('P6: payment for cancelled order alerts admin and is not delivered', async () => {
        const code = newOrder('cancelled');
        await processIncomingPayment(bot, { orderCode: code, amount: 50000, transactionId: 't6', source: 'T' });
        expect(db.getOrderByCode(code).status).toBe('cancelled');
        expect(sent.some((m) => m.text.includes('ĐÃ HỦY'))).toBe(true);
    });
});

describe('backup', () => {
    it('B1: createBackup writes a valid sqlite snapshot', () => {
        const fs = require('fs');
        const { file, size } = createBackup();
        expect(fs.existsSync(file)).toBe(true);
        expect(size).toBeGreaterThan(0);
        expect(fs.readFileSync(file).subarray(0, 15).toString()).toBe('SQLite format 3');
    });
});

describe('discount prompt preference', () => {
    it('D1: enabled by default, can be turned off and on', () => {
        expect(db.isDiscountPromptEnabled(4242)).toBe(true);
        db.setDiscountPromptEnabled(4242, false);
        expect(db.isDiscountPromptEnabled(4242)).toBe(false);
        db.setDiscountPromptEnabled(4242, true);
        expect(db.isDiscountPromptEnabled(4242)).toBe(true);
    });
});
