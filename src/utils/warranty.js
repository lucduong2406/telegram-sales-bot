/** Warranty helpers: window is counted from delivered_at. */
function getWarrantyStatus(order, product, now = new Date()) {
    const days = product && product.warranty_days;
    if (!days) return { hasWarranty: false };
    if (order.status !== 'delivered' || !order.delivered_at) return { hasWarranty: true, active: false, pending: true };
    const end = new Date(new Date(order.delivered_at).getTime() + days * 86400000);
    const daysLeft = Math.ceil((end - now) / 86400000);
    return { hasWarranty: true, active: daysLeft > 0, daysLeft: Math.max(0, daysLeft), end };
}

const REASONS = {
    login: { vi: 'Không đăng nhập được', en: "Can't log in" },
    password: { vi: 'Sai mật khẩu', en: 'Wrong password' },
    expired: { vi: 'Tài khoản hết hạn / bị khoá', en: 'Expired / locked account' },
    other: { vi: 'Lỗi khác', en: 'Other issue' },
};

module.exports = { getWarrantyStatus, REASONS };
