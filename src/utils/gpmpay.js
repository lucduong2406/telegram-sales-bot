const { GpmPay, buildVietQrImageUrl, buildVietQrPayload } = require('@gpmpay/sdk');
const QRCode = require('qrcode');
const config = require('../config');
const db = require('../database');

let gpmPayClient = null;

/**
 * Get (lazily init) the GpmPay SDK client.
 * Throws GpmPayConfigError if token is missing or invalid — app should crash.
 */
function getGpmPayClient() {
    if (!gpmPayClient) {
        if (!config.gpmpayApiToken) {
            throw new Error('GPMPAY_API_TOKEN is not set — GPM Pay is not configured');
        }
        gpmPayClient = new GpmPay({ apiToken: config.gpmpayApiToken });
    }
    return gpmPayClient;
}

/**
 * Get the active bank account for building GPM Pay VietQR.
 * Falls back to DB bank_accounts, then env vars.
 */
function getActiveBankAccount() {
    const bank = db.getBankConfig();
    return {
        bankBin: bank.id,        // BIN (e.g. "970423")
        accountNumber: bank.accountNo,
        accountName: bank.accountName,
        bankName: bank.name,
    };
}

/**
 * Build a GPM Pay VietQR image URL using the official SDK.
 * The order code is embedded in the description (transfer content) for matching.
 *
 * @param {number} amount - Payment amount in VND (integer)
 * @param {string} orderCode - Order code embedded in QR content
 * @returns {string} VietQR image URL
 */
function buildGpmPayQrUrl(amount, orderCode) {
    const bank = getActiveBankAccount();
    return buildVietQrImageUrl({
        bankBin: bank.bankBin,
        accountNumber: bank.accountNumber,
        amount: Math.round(amount),   // VND, integer
        description: orderCode,       // becomes transfer content (max 25 chars)
    });
}

/**
 * Render the VietQR payload as a PNG buffer.
 * img.vietqr.io now serves SVG only, which Telegram's sendPhoto rejects.
 */
function buildGpmPayQrPng(amount, orderCode) {
    const bank = getActiveBankAccount();
    const payload = buildVietQrPayload({
        bankBin: bank.bankBin,
        accountNumber: bank.accountNumber,
        amount: Math.round(amount),
        description: orderCode,
    });
    return QRCode.toBuffer(payload, { type: 'png', width: 512, margin: 2 });
}

module.exports = { getGpmPayClient, getActiveBankAccount, buildGpmPayQrUrl, buildGpmPayQrPng };
