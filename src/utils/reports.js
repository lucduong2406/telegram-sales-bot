const db = require('../database');

const TZ_OFFSET = '+7 hours'; // Vietnam time
const PAID = ['paid', 'delivering', 'delivered'];

function queryRows(sql, params) {
    const stmt = db.getDb().prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
}

/** Orders in range [from, to] (YYYY-MM-DD, VN time) by payment date (or creation date if unpaid). */
function getReportOrders({ from, to, status, payment_method } = {}) {
    const day = `DATE(COALESCE(o.paid_at, o.created_at), '${TZ_OFFSET}')`;
    const where = ['COALESCE(o.is_deleted, 0) = 0', 'COALESCE(o.include_in_analytics, 1) = 1'];
    const params = [];
    if (from) { where.push(`${day} >= ?`); params.push(from); }
    if (to) { where.push(`${day} <= ?`); params.push(to); }
    if (status) { where.push('o.status = ?'); params.push(status); }
    if (payment_method) { where.push('o.payment_method = ?'); params.push(payment_method); }
    return queryRows(`
      SELECT o.order_code, o.telegram_user_id, o.telegram_username, o.product_name, o.quantity,
             o.unit_price, o.discount_code, COALESCE(o.discount_amount, 0) AS discount_amount,
             o.total_amount, o.status, o.payment_method, o.payment_currency, o.source,
             COALESCE(p.cost_price, 0) AS cost_price,
             datetime(o.created_at, '${TZ_OFFSET}') AS created_at,
             datetime(o.paid_at, '${TZ_OFFSET}') AS paid_at,
             ${day} AS day
      FROM orders o LEFT JOIN products p ON o.product_id = p.id
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(o.paid_at, o.created_at) ASC`, params);
}

function bucketKey(day, group) {
    if (group === 'month') return day.slice(0, 7);
    if (group === 'week') {
        const d = new Date(day + 'T00:00:00Z');
        const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
        d.setUTCDate(d.getUTCDate() - dow);
        return d.toISOString().slice(0, 10);
    }
    return day;
}

function buildReport(rows, group = 'day') {
    const summary = {
        orders: rows.length, paidOrders: 0, pendingOrders: 0, expiredOrders: 0, cancelledOrders: 0,
        revenue: 0, discount: 0, cost: 0, profit: 0, avgOrder: 0, itemsSold: 0,
    };
    const byMethod = {}, byProduct = {}, byPeriod = {}, byStatus = {};
    for (const r of rows) {
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
        if (r.status === 'expired') summary.expiredOrders++;
        else if (r.status === 'cancelled') summary.cancelledOrders++;
        else if (r.status === 'pending') summary.pendingOrders++;
        if (!PAID.includes(r.status)) continue;
        const cost = (r.cost_price || 0) * r.quantity;
        summary.paidOrders++;
        summary.revenue += r.total_amount;
        summary.discount += r.discount_amount;
        summary.cost += cost;
        summary.itemsSold += r.quantity;
        const m = byMethod[r.payment_method || 'unknown'] ||= { key: r.payment_method || 'unknown', orders: 0, revenue: 0 };
        m.orders++; m.revenue += r.total_amount;
        const p = byProduct[r.product_name] ||= { key: r.product_name, orders: 0, quantity: 0, revenue: 0, profit: 0 };
        p.orders++; p.quantity += r.quantity; p.revenue += r.total_amount; p.profit += r.total_amount - cost;
        const k = bucketKey(r.day, group);
        const b = byPeriod[k] ||= { key: k, orders: 0, revenue: 0 };
        b.orders++; b.revenue += r.total_amount;
    }
    summary.profit = summary.revenue - summary.cost;
    summary.avgOrder = summary.paidOrders ? Math.round(summary.revenue / summary.paidOrders) : 0;
    const sortKey = (a, b) => (a.key < b.key ? -1 : 1);
    return {
        summary,
        byStatus,
        byMethod: Object.values(byMethod).sort((a, b) => b.revenue - a.revenue),
        byProduct: Object.values(byProduct).sort((a, b) => b.revenue - a.revenue),
        byPeriod: Object.values(byPeriod).sort(sortKey),
    };
}

function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV with UTF-8 BOM so Excel opens Vietnamese text correctly. */
function buildCsv(rows) {
    const head = ['Mã đơn', 'Ngày tạo', 'Ngày thanh toán', 'Khách (ID)', 'Username', 'Sản phẩm', 'SL', 'Đơn giá',
        'Mã giảm giá', 'Giảm giá', 'Tổng tiền', 'Giá vốn', 'Lợi nhuận', 'Phương thức', 'Trạng thái', 'Nguồn'];
    const lines = [head.map(csvCell).join(',')];
    for (const r of rows) {
        const paid = PAID.includes(r.status);
        const cost = (r.cost_price || 0) * r.quantity;
        lines.push([r.order_code, r.created_at, r.paid_at, r.telegram_user_id, r.telegram_username, r.product_name,
            r.quantity, r.unit_price, r.discount_code, r.discount_amount, r.total_amount,
            paid ? cost : '', paid ? r.total_amount - cost : '', r.payment_method, r.status, r.source].map(csvCell).join(','));
    }
    return '﻿' + lines.join('\r\n');
}

module.exports = { getReportOrders, buildReport, buildCsv };
