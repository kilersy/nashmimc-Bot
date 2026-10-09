/* =========================================================
   NashmiMC Store Bot — Production Build v7
   Features:
   - Bi-directional sync: Admin Panel ↔ Discord
   - Accept / Reject / Reset buttons in Discord (English)
   - Timestamps in Discord order messages
   - PostgreSQL persistence (with message IDs)
   - Auto-invoice PNG for PayPal
   - USDT payment proof images
   - Rate limiting + strict validation + XSS sanitization
   ========================================================= */

'use strict';

const {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder
} = require('discord.js');

const express = require('express');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

let createCanvas;
try {
    ({ createCanvas } = require('@napi-rs/canvas'));
} catch (err) {
    console.warn('[CANVAS] @napi-rs/canvas is not installed. Auto-invoice image will be disabled.');
    createCanvas = null;
}

const app = express();

/* =========================================================
   CONFIG
   ========================================================= */
const PORT = Number(process.env.PORT) || 10000;
const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID || '1551626123585130546';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_MODE = (process.env.PAYPAL_MODE || 'live').toLowerCase();
const PAYPAL_BASE_URL = PAYPAL_MODE === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';

const FRONTEND_URL = process.env.FRONTEND_URL || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

/* =========================================================
   PRODUCT CATALOG
   ========================================================= */
const PRODUCT_CATALOG = {
    'VIP Rank': 3.99,
    'MVP Rank': 9.99,
    'MVP+ Rank': 17.99,
    'NASHMI Rank': 29.99,
    'NASHMI+ Rank': 59.99,

    '100k SMP Money': 0.99,
    '300k SMP Money': 2.49,
    '500k SMP Money': 4.99,
    '1M SMP Money': 9.99,
    '3M SMP Money': 24.99,
    '5M SMP Money': 49.99,
    '10M SMP Money': 74.99,

    '100 SMP Gold': 0.99,
    '720 SMP Gold': 4.99,
    '1680 SMP Gold': 9.99,
    '3600 SMP Gold': 19.99,
    '6580 SMP Gold': 34.99,
    '10,000 SMP Gold': 49.99,
    '16,600 SMP Gold': 74.99,
    '22,400 SMP Gold': 99.99,

    '100 Box Gold': 0.99,
    '720 Box Gold': 4.99,
    '1680 Box Gold': 9.99,
    '3600 Box Gold': 19.99,
    '6580 Box Gold': 34.99,
    '10,000 Box Gold': 49.99,
    '16,400 Box Gold': 74.99,
    '22,400 Box Gold': 99.99,

    'DOOM key': 2.49,
    'MAGMA Key': 4.99,
    'MYTHIC Key': 9.99,
    'Mecha Key': 5.00
};

const ALLOWED_KEY_PRODUCTS = ['DOOM key', 'MAGMA Key', 'MYTHIC Key', 'Mecha Key'];
const VALID_COUPON = 'NASHMI2026';
const COUPON_DISCOUNT = 0.15;

/* =========================================================
   POSTGRESQL POOL
   ========================================================= */
let db = null;
let dbReady = false;

if (DATABASE_URL) {
    db = new Pool({
        connectionString: DATABASE_URL,
        ssl: DATABASE_URL.includes('render.com') || process.env.PGSSLMODE === 'require'
            ? { rejectUnauthorized: false }
            : false,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
    });

    db.on('error', (err) => {
        console.error('[DB] Unexpected pool error:', err.message);
    });
} else {
    console.warn('[DB] DATABASE_URL is not set. PostgreSQL is disabled.');
}

/* =========================================================
   DATABASE INIT
   ========================================================= */
async function initDatabase() {
    if (!db) return;

    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id                VARCHAR(64) PRIMARY KEY,
                ign               VARCHAR(16) NOT NULL,
                discord_user      VARCHAR(64) NOT NULL,
                payment_method    VARCHAR(16) NOT NULL,
                payment_reference VARCHAR(255),
                subtotal          NUMERIC(10, 2) NOT NULL,
                total             NUMERIC(10, 2) NOT NULL,
                coupon_code       VARCHAR(32),
                items             JSONB NOT NULL,
                status            VARCHAR(32) NOT NULL DEFAULT 'pending',
                paypal_order_id   VARCHAR(128),
                discord_message_id VARCHAR(64),
                discord_channel_id VARCHAR(64),
                created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        // Idempotent ALTERs for existing tables
        await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discord_message_id VARCHAR(64)`);
        await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discord_channel_id VARCHAR(64)`);

        await db.query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status)`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC)`);
        await db.query(`CREATE INDEX IF NOT EXISTS idx_orders_paypal_order_id ON orders (paypal_order_id)`);

        dbReady = true;
        console.log('[DB] Connected and schema ready.');

        const result = await db.query('SELECT COUNT(*)::int AS count FROM orders');
        console.log(`[DB] Orders in database: ${result.rows[0].count}`);
    } catch (err) {
        console.error('[DB] Init failed:', err.message);
        dbReady = false;
    }
}

function rowToOrder(row) {
    return {
        id: row.id,
        ign: row.ign,
        discordUser: row.discord_user,
        paymentMethod: row.payment_method,
        paymentReference: row.payment_reference,
        subtotal: Number(row.subtotal),
        total: Number(row.total),
        couponCode: row.coupon_code,
        items: row.items,
        status: row.status,
        paypalOrderId: row.paypal_order_id,
        discordMessageId: row.discord_message_id,
        discordChannelId: row.discord_channel_id,
        date: row.created_at instanceof Date
            ? row.created_at.toISOString()
            : String(row.created_at)
    };
}

async function addOrder(order) {
    if (!dbReady) {
        console.warn('[DB] addOrder called but DB is not ready.');
        return false;
    }

    try {
        await db.query(
            `INSERT INTO orders (
                id, ign, discord_user, payment_method, payment_reference,
                subtotal, total, coupon_code, items, status, paypal_order_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
                order.id,
                order.ign,
                order.discordUser,
                order.paymentMethod,
                order.paymentReference || null,
                order.subtotal,
                order.total,
                order.couponCode || null,
                JSON.stringify(order.items),
                order.status,
                order.paypalOrderId || null
            ]
        );
        return true;
    } catch (err) {
        console.error('[DB] addOrder failed:', err.message);
        return false;
    }
}

async function findOrderById(id) {
    if (!dbReady || !id) return null;

    try {
        const result = await db.query(
            `SELECT * FROM orders WHERE UPPER(id) = UPPER($1) LIMIT 1`,
            [String(id)]
        );

        if (result.rows.length === 0) return null;
        return rowToOrder(result.rows[0]);
    } catch (err) {
        console.error('[DB] findOrderById failed:', err.message);
        return null;
    }
}

async function updateOrderStatus(id, status) {
    if (!dbReady) return false;

    try {
        const result = await db.query(
            `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
            [status, id]
        );
        return result.rowCount > 0;
    } catch (err) {
        console.error('[DB] updateOrderStatus failed:', err.message);
        return false;
    }
}

async function saveDiscordMessageIds(orderId, messageId, channelId) {
    if (!dbReady) return false;

    try {
        await db.query(
            `UPDATE orders SET discord_message_id = $1, discord_channel_id = $2 WHERE id = $3`,
            [messageId, channelId, orderId]
        );
        return true;
    } catch (err) {
        console.error('[DB] saveDiscordMessageIds failed:', err.message);
        return false;
    }
}

async function getStats() {
    if (!dbReady) {
        return { ok: false, error: 'DB not ready' };
    }

    try {
        await db.query(`UPDATE orders SET status = 'pending'  WHERE status IN ('قيد الانتظار', 'pending')`);
        await db.query(`UPDATE orders SET status = 'approved' WHERE status IN ('مقبول', 'approved')`);
        await db.query(`UPDATE orders SET status = 'rejected' WHERE status IN ('مرفوض', 'rejected')`);

        const countersResult = await db.query(`
            SELECT
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'pending')::int  AS pending,
              COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
              COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
            FROM orders
        `);

        const counters = countersResult.rows[0];

        const revenueResult = await db.query(`
            SELECT COALESCE(SUM(total), 0)::numeric AS revenue
            FROM orders
            WHERE status = 'approved'
        `);

        const recentResult = await db.query(`
            SELECT * FROM orders
            ORDER BY created_at DESC
            LIMIT 100
        `);

        return {
            ok: true,
            totalOrders: counters.total,
            byStatus: {
                'pending':  counters.pending,
                'approved': counters.approved,
                'rejected': counters.rejected
            },
            totalRevenue: Number(revenueResult.rows[0].revenue),
            recentOrders: recentResult.rows.map(rowToOrder)
        };
    } catch (err) {
        console.error('[DB] getStats failed:', err.message);
        return { ok: false, error: err.message };
    }
}

/* =========================================================
   EXPRESS
   ========================================================= */
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ limit: '12mb', extended: true }));

app.use((req, res, next) => {
    if (FRONTEND_URL) {
        res.header('Access-Control-Allow-Origin', FRONTEND_URL);
        res.header('Vary', 'Origin');
    } else {
        res.header('Access-Control-Allow-Origin', '*');
    }

    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests. Please slow down.' }
});

const orderLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many order attempts. Please wait a minute.' }
});

const trackingLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many tracking requests.' }
});

app.use(globalLimiter);

/* =========================================================
   DISCORD CLIENT
   ========================================================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* =========================================================
   HELPERS
   ========================================================= */
function roundMoney(v) {
    return Number(Number(v).toFixed(2));
}

function createServerOrderId() {
    return 'NASHMI-' +
        Math.random().toString(36).substring(2, 8).toUpperCase() + '-' +
        Math.random().toString(36).substring(2, 8).toUpperCase();
}

function normalizeText(value, maxLength = 200) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/\s+/g, ' ').substring(0, maxLength);
}

function isValidIgn(ign) {
    return typeof ign === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(ign.trim());
}

function isValidDiscordUser(value) {
    if (typeof value !== 'string') return false;
    return /^[a-zA-Z0-9._]{2,32}(#\d{4})?$/.test(value.trim());
}

function isValidCoupon(code) {
    return typeof code === 'string' && code.trim().toUpperCase() === VALID_COUPON;
}

function calculateDiscountedTotal(subtotal, couponCode) {
    const discount = isValidCoupon(couponCode) ? COUPON_DISCOUNT : 0;
    return roundMoney(subtotal * (1 - discount));
}

function sanitizeForDiscord(value, maxLength = 300) {
    if (value == null) return '';
    let s = String(value);
    s = s.replace(/[\\`*_{}[\]()#+\-.!|>~]/g, '\\$&');
    s = s.replace(/@(everyone|here|&)/g, '@\u200b$1');
    s = s.replace(/[\r\n]+/g, ' ');
    return s.substring(0, maxLength);
}

function formatDiscordTimestamp(isoString) {
    try {
        const unix = Math.floor(new Date(isoString).getTime() / 1000);
        return `<t:${unix}:F>`; // Full date/time (localized)
    } catch (_) {
        return 'Unknown';
    }
}

/* =========================================================
   CUSTOM RANK VALIDATION
   ========================================================= */
function parseCustomRankItem(item) {
    if (!item || typeof item.title !== 'string') return null;

    const title = item.title.trim();
    const titleMatch = title.match(/^Custom Rank:\s*\[([A-Za-z0-9_-]{1,16})\]$/i);
    if (!titleMatch) return null;

    const rankName = titleMatch[1].toUpperCase();
    const details = typeof item.details === 'string' ? item.details : '';

    const pvMatch = details.match(/PVs:\s*(\d+)/i);
    const homesMatch = details.match(/Homes:\s*(\d+)/i);
    const ecMatch = details.match(/EC:\s*([^|]+)/i);
    const anvilMatch = details.match(/Anvil:\s*(Yes|No)/i);
    const tagsMatch = details.match(/Tags:\s*(Yes|No)/i);
    const safeRoomMatch = details.match(/SafeRoom:\s*(Yes|No)/i);
    const colorMatch = details.match(/Color:\s*([^|]+)/i);

    if (!pvMatch || !homesMatch || !ecMatch || !anvilMatch ||
        !tagsMatch || !safeRoomMatch || !colorMatch) return null;

    const pv = Number(pvMatch[1]);
    const homes = Number(homesMatch[1]);

    if (!Number.isInteger(pv) || pv < 0 || pv > 10) return null;
    if (!Number.isInteger(homes) || homes < 2 || homes > 7) return null;

    const ecText = ecMatch[1].trim();
    let ecPrice = 0;

    if (ecText.toLowerCase().includes('normal enderchest')) ecPrice = 2;
    else if (ecText.toLowerCase().includes('double enderchest')) ecPrice = 4;
    else if (!ecText.toLowerCase().includes('none')) return null;

    const anvil = anvilMatch[1].toLowerCase() === 'yes';
    const tags = tagsMatch[1].toLowerCase() === 'yes';
    const safeRoom = safeRoomMatch[1].toLowerCase() === 'yes';

    const colorText = colorMatch[1].trim();
    const hasColor = !colorText.toLowerCase().includes('default accent color');

    let price = 5;
    price += pv * 3;
    if (homes > 2) price += (homes - 2) * 1.5;
    price += ecPrice;
    if (anvil) price += 3;
    if (tags) price += 4;
    if (safeRoom) price += 5;
    if (hasColor) price += 3;
    price = roundMoney(price);

    const rebuiltDetails =
        `Rank Name: [${rankName}] | ` +
        `Color: ${colorText} | ` +
        `PVs: ${pv} | Homes: ${homes} | EC: ${ecText} | ` +
        `Anvil: ${anvil ? 'Yes' : 'No'} | Tags: ${tags ? 'Yes' : 'No'} | SafeRoom: ${safeRoom ? 'Yes' : 'No'}`;

    return {
        title: `Custom Rank: [${rankName}]`,
        price,
        details: rebuiltDetails
    };
}

/* =========================================================
   FIXED PRODUCT VALIDATION
   ========================================================= */
function parseFixedProductItem(item) {
    if (!item || typeof item.title !== 'string') return null;

    const rawTitle = item.title.trim();

    if (Object.prototype.hasOwnProperty.call(PRODUCT_CATALOG, rawTitle)) {
        return {
            title: rawTitle,
            price: PRODUCT_CATALOG[rawTitle]
        };
    }

    const quantityMatch = rawTitle.match(/^(\d+)\s*x\s*(.+)$/i);
    if (!quantityMatch) return null;

    const quantity = Number(quantityMatch[1]);
    const productName = quantityMatch[2].trim();

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return null;
    if (!ALLOWED_KEY_PRODUCTS.includes(productName)) return null;

    const unitPrice = PRODUCT_CATALOG[productName];

    return {
        title: `${quantity}x ${productName}`,
        price: roundMoney(unitPrice * quantity),
        details: `Quantity: ${quantity} | Unit Price: $${unitPrice.toFixed(2)}`
    };
}

/* =========================================================
   CART VALIDATION
   ========================================================= */
function validateAndBuildCart(items) {
    if (!Array.isArray(items)) throw new Error('Invalid cart.');
    if (items.length < 1 || items.length > 50) {
        throw new Error('Cart contains an invalid number of items.');
    }

    const validatedItems = [];

    for (const item of items) {
        const fixedItem = parseFixedProductItem(item);
        if (fixedItem) { validatedItems.push(fixedItem); continue; }

        const customItem = parseCustomRankItem(item);
        if (customItem) { validatedItems.push(customItem); continue; }

        throw new Error(`Invalid product: ${normalizeText(item?.title || 'Unknown')}`);
    }

    const subtotal = roundMoney(
        validatedItems.reduce((sum, item) => sum + Number(item.price), 0)
    );

    return { items: validatedItems, subtotal };
}

/* =========================================================
   AUTO INVOICE IMAGE GENERATOR
   ========================================================= */
function generateInvoiceImage(order) {
    if (!createCanvas) return null;

    try {
        const width = 900;
        const rowHeight = 34;
        const itemsCount = order.items.length;

        const headerHeight = 260;
        const itemsHeight = itemsCount * rowHeight + 80;
        const footerHeight = 180;
        const height = headerHeight + itemsHeight + footerHeight;

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, '#0b0f19');
        grad.addColorStop(1, '#131b2e');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = '#fbbf24';
        ctx.fillRect(0, 0, width, 6);

        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 42px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('NASHMIMC NETWORK', width / 2, 80);

        ctx.fillStyle = '#94a3b8';
        ctx.font = '20px sans-serif';
        ctx.fillText('PAYMENT INVOICE', width / 2, 115);

        ctx.strokeStyle = '#3b3561';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(60, 145);
        ctx.lineTo(width - 60, 145);
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.fillStyle = '#fef3c7';
        ctx.font = 'bold 22px sans-serif';
        ctx.fillText('Order ID:', 60, 190);
        ctx.fillText('Player IGN:', 60, 225);

        ctx.fillText('Discord:', 480, 190);
        ctx.fillText('Payment:', 480, 225);

        ctx.fillStyle = '#fbbf24';
        ctx.font = '22px monospace';
        ctx.fillText(order.id, 200, 190);
        ctx.fillText(String(order.ign), 200, 225);

        ctx.fillText(String(order.discordUser), 620, 190);
        ctx.fillText(String(order.paymentMethod), 620, 225);

        const dateStr = new Date(order.date).toLocaleString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });

        ctx.fillStyle = '#94a3b8';
        ctx.font = '16px sans-serif';
        ctx.fillText(`Date: ${dateStr}`, 60, 265);

        let y = 310;
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 20px sans-serif';
        ctx.fillText('ITEMS', 60, y);

        ctx.strokeStyle = '#3b3561';
        ctx.beginPath();
        ctx.moveTo(60, y + 10);
        ctx.lineTo(width - 60, y + 10);
        ctx.stroke();

        y += 50;

        order.items.forEach((item, index) => {
            const title = item.title.length > 55
                ? item.title.substring(0, 52) + '...'
                : item.title;

            ctx.fillStyle = index % 2 === 0 ? '#1a2340' : '#131b2e';
            ctx.fillRect(60, y - 22, width - 120, 30);

            ctx.fillStyle = '#fef3c7';
            ctx.font = '18px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(title, 75, y);

            ctx.fillStyle = '#fbbf24';
            ctx.font = 'bold 18px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`$${Number(item.price).toFixed(2)}`, width - 75, y);

            y += rowHeight;
        });

        y += 20;
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(480, y);
        ctx.lineTo(width - 60, y);
        ctx.stroke();

        y += 35;

        ctx.textAlign = 'left';
        ctx.fillStyle = '#94a3b8';
        ctx.font = '18px sans-serif';
        ctx.fillText('Subtotal:', 480, y);

        ctx.textAlign = 'right';
        ctx.fillStyle = '#fef3c7';
        ctx.fillText(`$${Number(order.subtotal).toFixed(2)}`, width - 75, y);

        if (order.couponCode) {
            y += 30;
            ctx.textAlign = 'left';
            ctx.fillStyle = '#94a3b8';
            ctx.fillText(`Discount (${order.couponCode}):`, 480, y);
            ctx.textAlign = 'right';
            ctx.fillStyle = '#10b981';
            ctx.fillText('-15%', width - 75, y);
        }

        y += 40;
        ctx.textAlign = 'left';
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 26px sans-serif';
        ctx.fillText('TOTAL:', 480, y);

        ctx.textAlign = 'right';
        ctx.font = 'bold 30px monospace';
        ctx.fillText(`$${Number(order.total).toFixed(2)} USD`, width - 75, y);

        y += 60;
        ctx.strokeStyle = '#3b3561';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(60, y);
        ctx.lineTo(width - 60, y);
        ctx.stroke();

        y += 30;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#94a3b8';
        ctx.font = '14px sans-serif';
        ctx.fillText('Thank you for your purchase! Delivery within 3-4 hours maximum.', width / 2, y);

        y += 22;
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText('play.nashmimc.net  |  discord.gg/mB37jz6E7N', width / 2, y);

        ctx.fillStyle = '#fbbf24';
        ctx.fillRect(0, height - 6, width, 6);

        return canvas.toBuffer('image/png');
    } catch (err) {
        console.error('[INVOICE] Failed to generate image:', err.message);
        return null;
    }
}

/* =========================================================
   DISCORD HELPERS
   ========================================================= */
async function fetchAdminChannel() {
    const channel = await client.channels.fetch(ADMIN_CHANNEL_ID);
    if (!channel) throw new Error('Admin Discord channel was not found.');
    if (!channel.isTextBased()) throw new Error('Admin Discord channel is not text based.');
    return channel;
}

function buildOrderMessage(order) {
    const itemsList = order.items.map(item => {
        const safeTitle = sanitizeForDiscord(item.title, 200);
        const safeDetails = item.details
            ? `\n  [Details: ${sanitizeForDiscord(item.details, 300)}]`
            : '';
        return `• ${safeTitle} - $${Number(item.price).toFixed(2)}${safeDetails}`;
    }).join('\n');

    const safeIgn = sanitizeForDiscord(order.ign, 32);
    const safeDiscord = sanitizeForDiscord(order.discordUser, 64);
    const safeMethod = sanitizeForDiscord(order.paymentMethod, 32);
    const safeRef = sanitizeForDiscord(order.paymentReference || 'N/A', 200);
    const timestamp = formatDiscordTimestamp(order.date);

    return (
        `🛒 **New Order from Nashmi Store!**\n` +
        `- **Order ID:** #${order.id}\n` +
        `- **Player IGN:** \`${safeIgn}\`\n` +
        `- **Discord:** \`${safeDiscord}\`\n` +
        `- **Payment Method:** ${safeMethod}\n` +
        `- **Total:** $${Number(order.total).toFixed(2)}\n` +
        `- **Date:** ${timestamp}\n` +
        `- **Status:** ⏳ Pending\n` +
        `- **Reference:** ${safeRef}\n\n` +
        `**Items:**\n${itemsList}`
    );
}

async function sendPaymentProof(channel, imageProof) {
    if (typeof imageProof !== 'string') return false;
    if (!imageProof.startsWith('data:image/')) return false;
    if (!imageProof.includes(';base64,')) return false;

    const match = imageProof.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
    if (!match) throw new Error('Invalid payment proof image format.');

    const extension = (match[1].toLowerCase() === 'jpeg' || match[1].toLowerCase() === 'jpg')
        ? 'jpg'
        : match[1].toLowerCase();

    const buffer = Buffer.from(match[2], 'base64');

    if (buffer.length > 7.5 * 1024 * 1024) {
        throw new Error('Payment proof image is too large.');
    }

    await channel.send({
        files: [{
            attachment: buffer,
            name: `usdt_payment_proof.${extension}`
        }],
        allowedMentions: { parse: [] }
    });

    return true;
}

function buildActionButtons(orderId, includeAll) {
    const row = new ActionRowBuilder();

    row.addComponents(
        new ButtonBuilder()
            .setCustomId(`accept_${orderId}`)
            .setLabel('Accept')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅')
    );

    row.addComponents(
        new ButtonBuilder()
            .setCustomId(`reject_${orderId}`)
            .setLabel('Reject')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
    );

    if (includeAll) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`reset_${orderId}`)
                .setLabel('Reset')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🔄')
        );
    }

    return row;
}

async function createDiscordOrder(order, imageProof = null) {
    const channel = await fetchAdminChannel();

    if (imageProof) {
        try {
            await sendPaymentProof(channel, imageProof);
            console.log('[DISCORD] USDT payment proof uploaded.');
        } catch (error) {
            console.error('[DISCORD] Failed to upload payment proof:', error.message);
        }
    }

    if (order.paymentMethod === 'PAYPAL' && !imageProof) {
        try {
            const invoiceBuffer = generateInvoiceImage(order);
            if (invoiceBuffer) {
                const attachment = new AttachmentBuilder(invoiceBuffer, {
                    name: `invoice_${order.id}.png`
                });
                await channel.send({
                    content: `🧾 **Auto-generated invoice for Order #${order.id}**`,
                    files: [attachment],
                    allowedMentions: { parse: [] }
                });
                console.log('[DISCORD] Auto-invoice sent.');
            }
        } catch (error) {
            console.error('[DISCORD] Failed to send invoice:', error.message);
        }
    }

    const row = buildActionButtons(order.id, true);

    const sentMessage = await channel.send({
        content: buildOrderMessage(order),
        components: [row],
        allowedMentions: { parse: [] }
    });

    // Save Discord message IDs for future syncs
    await saveDiscordMessageIds(order.id, sentMessage.id, sentMessage.channel.id);

    console.log(`[DISCORD] Order ${order.id} posted (message ${sentMessage.id}).`);
}

async function syncDiscordMessage(orderId, newStatus, actorName) {
    const order = await findOrderById(orderId);
    if (!order) return;

    if (!order.discordMessageId || !order.discordChannelId) {
        console.log(`[SYNC] Skipping Discord sync for ${orderId} (no message info).`);
        return;
    }

    try {
        const channel = await client.channels.fetch(order.discordChannelId);
        if (!channel || !channel.isTextBased()) return;

        const message = await channel.messages.fetch(order.discordMessageId);
        if (!message) return;

        let statusEmoji = '⏳';
        let statusText = 'Pending';

        if (newStatus === 'approved') {
            statusEmoji = '✅';
            statusText = 'Approved';
        } else if (newStatus === 'rejected') {
            statusEmoji = '❌';
            statusText = 'Rejected';
        }

        const actorSuffix = actorName ? ` (by ${actorName})` : '';
        const newStatusLine = `- **Status:** ${statusEmoji} **${statusText}**${actorSuffix}`;

        const statusLineRegex = /- \*\*Status:\*\* .*/;
        let newContent = message.content;

        if (statusLineRegex.test(newContent)) {
            newContent = newContent.replace(statusLineRegex, newStatusLine);
        } else {
            newContent += `\n${newStatusLine}`;
        }

        const components = newStatus === 'pending'
            ? [buildActionButtons(orderId, true)]
            : [];

        await message.edit({
            content: newContent,
            components
        });

        console.log(`[SYNC] Discord message updated for ${orderId} → ${newStatus}`);
    } catch (error) {
        console.error(`[SYNC] Failed to update Discord message for ${orderId}:`, error.message);
    }
}

/* =========================================================
   PAYPAL HELPERS
   ========================================================= */
function ensurePayPalConfigured() {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
        throw new Error('PayPal environment variables are not configured.');
    }
}

async function paypalAccessToken() {
    ensurePayPalConfigured();

    const credentials = Buffer.from(
        `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
    ).toString('base64');

    const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });

    const data = await response.json();

    if (!response.ok || !data.access_token) {
        console.error('[PAYPAL] OAuth error:', data);
        throw new Error('Unable to authenticate with PayPal.');
    }

    return data.access_token;
}

async function paypalCreateOrder(total, internalOrderId) {
    const accessToken = await paypalAccessToken();

    const payload = {
        intent: 'CAPTURE',
        purchase_units: [{
            reference_id: internalOrderId,
            amount: {
                currency_code: 'USD',
                value: Number(total).toFixed(2)
            }
        }]
    };

    const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'PayPal-Request-Id': internalOrderId
        },
        body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
        console.error('[PAYPAL] Create order error:', data);
        throw new Error(data?.message || 'PayPal could not create the order.');
    }

    return data;
}

async function paypalCaptureOrder(paypalOrderId) {
    const accessToken = await paypalAccessToken();

    const response = await fetch(
        `${PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        }
    );

    const data = await response.json();

    if (!response.ok) {
        console.error('[PAYPAL] Capture error:', data);
        throw new Error(data?.message || 'PayPal could not capture the payment.');
    }

    return data;
}

function getCapturedAmount(paypalResponse) {
    const capture = paypalResponse?.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture) return null;
    return {
        status: capture.status,
        value: Number(capture?.amount?.value),
        currency: capture?.amount?.currency_code
    };
}

/* =========================================================
   ADMIN AUTH MIDDLEWARE
   ========================================================= */
function adminAuth(req, res, next) {
    if (!ADMIN_PASSWORD) {
        return res.status(503).send('Admin password not configured. Set ADMIN_PASSWORD env var on Render.');
    }

    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="NashmiMC Admin"');
        return res.status(401).send('Authentication required.');
    }

    const decoded = Buffer.from(authHeader.substring(6), 'base64').toString('utf8');
    const separatorIdx = decoded.indexOf(':');
    const password = separatorIdx >= 0 ? decoded.substring(separatorIdx + 1) : decoded;

    if (password !== ADMIN_PASSWORD) {
        res.set('WWW-Authenticate', 'Basic realm="NashmiMC Admin"');
        return res.status(401).send('Invalid credentials.');
    }

    next();
}

/* =========================================================
   HEALTH
   ========================================================= */
app.get('/health', async (req, res) => {
    let dbStatus = 'disabled';
    let dbOrders = null;

    if (db) {
        try {
            const r = await db.query('SELECT COUNT(*)::int AS count FROM orders');
            dbStatus = 'connected';
            dbOrders = r.rows[0].count;
        } catch (err) {
            dbStatus = 'error: ' + err.message;
        }
    }

    res.json({
        ok: true,
        bot: client.isReady(),
        paypal: Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET),
        mode: PAYPAL_MODE,
        invoice: Boolean(createCanvas),
        admin: Boolean(ADMIN_PASSWORD),
        db: dbStatus,
        ordersCount: dbOrders
    });
});

/* =========================================================
   STATS API (with cache)
   ========================================================= */
let statsCache = { data: null, timestamp: 0 };
const STATS_CACHE_TTL = 10000;

app.get('/api/stats', trackingLimiter, async (req, res) => {
    const now = Date.now();

    if (statsCache.data && (now - statsCache.timestamp) < STATS_CACHE_TTL) {
        return res.json(statsCache.data);
    }

    const stats = await getStats();
    statsCache = { data: stats, timestamp: now };
    res.json(stats);
});

/* =========================================================
   POST /api/new-order — CRYPTO
   ========================================================= */
app.post('/api/new-order', orderLimiter, async (req, res) => {
    console.log('[API] New crypto order received.');

    try {
        const { ign, discordUser, paymentMethod, items, couponCode, imageProof } = req.body || {};

        if (!isValidIgn(ign)) {
            return res.status(400).json({ success: false, error: 'Invalid Minecraft username.' });
        }

        if (!isValidDiscordUser(discordUser)) {
            return res.status(400).json({ success: false, error: 'Invalid Discord username.' });
        }

        const method = String(paymentMethod || '').trim().toUpperCase();
        if (method !== 'CRYPTO') {
            return res.status(400).json({ success: false, error: 'Invalid payment method for this endpoint.' });
        }

        if (typeof imageProof !== 'string' || !imageProof.startsWith('data:image/')) {
            return res.status(400).json({ success: false, error: 'Payment proof image is required for Crypto orders.' });
        }

        const cart = validateAndBuildCart(items);
        const total = calculateDiscountedTotal(cart.subtotal, couponCode);
        const orderId = createServerOrderId();

        const order = {
            id: orderId,
            ign: ign.trim(),
            discordUser: normalizeText(discordUser, 100),
            paymentMethod: 'CRYPTO',
            paymentReference: 'Manual Crypto Payment',
            subtotal: cart.subtotal,
            total,
            couponCode: isValidCoupon(couponCode) ? VALID_COUPON : null,
            items: cart.items,
            date: new Date().toISOString(),
            status: 'pending'
        };

        await addOrder(order);
        await createDiscordOrder(order, imageProof);

        console.log(`[SUCCESS] Crypto order ${order.id}`);

        return res.json({
            success: true,
            orderId: order.id,
            total: order.total,
            status: order.status
        });
    } catch (error) {
        console.error('[CRITICAL] /api/new-order:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Server error while processing order.'
        });
    }
});

/* =========================================================
   POST /api/paypal/create-order
   ========================================================= */
app.post('/api/paypal/create-order', orderLimiter, async (req, res) => {
    console.log('[PAYPAL] Creating server-side PayPal order.');

    try {
        const { clientOrderId, ign, discordUser, items, couponCode } = req.body || {};

        if (!isValidIgn(ign)) {
            return res.status(400).json({ success: false, error: 'Invalid Minecraft username.' });
        }

        if (!isValidDiscordUser(discordUser)) {
            return res.status(400).json({ success: false, error: 'Invalid Discord username.' });
        }

        const cart = validateAndBuildCart(items);
        const total = calculateDiscountedTotal(cart.subtotal, couponCode);

        if (total <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid payment total.' });
        }

        const internalOrderId = createServerOrderId();
        const paypalOrder = await paypalCreateOrder(total, internalOrderId);

        if (!paypalOrder?.id) {
            throw new Error('PayPal did not return an order ID.');
        }

        pendingPayPalOrders.set(paypalOrder.id, {
            internalOrderId,
            clientOrderId: normalizeText(clientOrderId, 100),
            ign: ign.trim(),
            discordUser: normalizeText(discordUser, 100),
            items: cart.items,
            subtotal: cart.subtotal,
            total,
            couponCode: isValidCoupon(couponCode) ? VALID_COUPON : null,
            createdAt: Date.now()
        });

        console.log(`[PAYPAL] Created ${paypalOrder.id} for ${total.toFixed(2)} USD`);

        return res.json({
            success: true,
            orderID: paypalOrder.id,
            total
        });
    } catch (error) {
        console.error('[PAYPAL] Create order failed:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Unable to create PayPal order.'
        });
    }
});

/* =========================================================
   POST /api/paypal/capture-order
   ========================================================= */
app.post('/api/paypal/capture-order', orderLimiter, async (req, res) => {
    console.log('[PAYPAL] Capturing PayPal order.');

    try {
        const { paypalOrderId } = req.body || {};

        if (typeof paypalOrderId !== 'string' || !paypalOrderId.trim()) {
            return res.status(400).json({ success: false, error: 'PayPal order ID is required.' });
        }

        const pending = pendingPayPalOrders.get(paypalOrderId);
        if (!pending) {
            return res.status(404).json({
                success: false,
                error: 'PayPal order session not found or expired. Please start again.'
            });
        }

        const maxPendingAge = 30 * 60 * 1000;
        if (Date.now() - pending.createdAt > maxPendingAge) {
            pendingPayPalOrders.delete(paypalOrderId);
            return res.status(410).json({ success: false, error: 'PayPal payment session expired.' });
        }

        const paypalResponse = await paypalCaptureOrder(paypalOrderId);
        const capture = getCapturedAmount(paypalResponse);

        if (!capture) throw new Error('PayPal capture information was not returned.');
        if (capture.status !== 'COMPLETED') {
            throw new Error(`PayPal payment not completed. Status: ${capture.status}`);
        }
        if (capture.currency !== 'USD') throw new Error('Unexpected PayPal currency.');

        if (Number(capture.value) !== Number(pending.total)) {
            console.error('[PAYPAL] Amount mismatch:', { expected: pending.total, received: capture.value });
            throw new Error('PayPal payment amount does not match the order total.');
        }

        const order = {
            id: pending.internalOrderId,
            ign: pending.ign,
            discordUser: pending.discordUser,
            paymentMethod: 'PAYPAL',
            paymentReference: `PayPal Order: ${paypalOrderId}`,
            subtotal: pending.subtotal,
            total: pending.total,
            couponCode: pending.couponCode,
            items: pending.items,
            date: new Date().toISOString(),
            status: 'pending',
            paypalOrderId
        };

        await addOrder(order);
        await createDiscordOrder(order, null);

        pendingPayPalOrders.delete(paypalOrderId);

        console.log(`[SUCCESS] PayPal payment completed for ${order.id}`);

        return res.json({
            success: true,
            orderId: order.id,
            paypalOrderId,
            total: order.total,
            status: order.status
        });
    } catch (error) {
        console.error('[PAYPAL] Capture order failed:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Unable to capture PayPal payment.'
        });
    }
});

/* =========================================================
   GET /api/orders/:orderId
   ========================================================= */
app.get('/api/orders/:orderId', trackingLimiter, async (req, res) => {
    const requestedId = normalizeText(req.params.orderId, 100).toUpperCase();
    const order = await findOrderById(requestedId);

    if (!order) {
        return res.status(404).json({ success: false, error: 'Order not found.' });
    }

    return res.json({
        success: true,
        id: order.id,
        date: order.date,
        total: order.total,
        status: order.status,
        items: order.items
    });
});

/* =========================================================
   POST /api/admin/update-order — accept / reject / reset
   ========================================================= */
app.post('/api/admin/update-order', adminAuth, orderLimiter, async (req, res) => {
    try {
        const { orderId, action } = req.body || {};

        if (typeof orderId !== 'string' || !orderId.trim()) {
            return res.status(400).json({ success: false, error: 'orderId is required.' });
        }

        const validActions = ['accept', 'reject', 'reset'];
        if (!validActions.includes(action)) {
            return res.status(400).json({ success: false, error: 'action must be accept, reject, or reset.' });
        }

        const order = await findOrderById(orderId);
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found.' });
        }

        let newStatus;
        if (action === 'accept') newStatus = 'approved';
        else if (action === 'reject') newStatus = 'rejected';
        else newStatus = 'pending';

        const updated = await updateOrderStatus(order.id, newStatus);

        if (!updated) {
            return res.status(500).json({ success: false, error: 'Failed to update order status.' });
        }

        // Sync to Discord
        await syncDiscordMessage(order.id, newStatus, 'Admin Panel');

        console.log(`[ADMIN] Order ${order.id} → ${newStatus}`);

        return res.json({ success: true, orderId: order.id, status: newStatus });
    } catch (error) {
        console.error('[ADMIN] update-order failed:', error);
        return res.status(500).json({ success: false, error: error.message || 'Internal error.' });
    }
});

/* =========================================================
   GET /admin — Dashboard
   ========================================================= */
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NashmiMC Admin — Orders</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root { --bg:#0a0e1a; --card:#131b2e; --card-hover:#1a2340; --border:#2d3654; --accent:#fbbf24; --text:#f1f5f9; --muted:#94a3b8; --success:#10b981; --danger:#ef4444; --warning:#f59e0b; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Inter',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; padding:20px; }
  .container { max-width:1500px; margin:0 auto; }
  header { display:flex; justify-content:space-between; align-items:center; padding:20px 0; border-bottom:2px solid var(--border); margin-bottom:30px; flex-wrap:wrap; gap:15px; }
  h1 { font-size:1.8rem; color:var(--accent); font-weight:800; letter-spacing:-0.5px; }
  h1 span { color:var(--text); font-weight:400; font-size:0.95rem; margin-left:12px; }
  .refresh-info { font-size:0.85rem; color:var(--muted); }
  .refresh-info strong { color:var(--accent); }
  .stats-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:15px; margin-bottom:30px; }
  .stat-card { background:var(--card); border:2px solid var(--border); border-radius:14px; padding:22px; transition:all 0.2s; }
  .stat-card:hover { border-color:var(--accent); transform:translateY(-2px); }
  .stat-label { font-size:0.85rem; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px; font-weight:600; }
  .stat-value { font-size:2.2rem; font-weight:800; color:var(--accent); }
  .stat-value.green { color:var(--success); }
  .stat-value.red { color:var(--danger); }
  .stat-value.yellow { color:var(--warning); }
  .search-bar { display:flex; gap:10px; margin-bottom:20px; flex-wrap:wrap; }
  .search-bar input, .search-bar select { background:var(--card); border:2px solid var(--border); color:var(--text); padding:12px 16px; border-radius:10px; font-size:0.95rem; outline:none; font-family:inherit; }
  .search-bar input { flex:1; min-width:200px; }
  .search-bar input:focus, .search-bar select:focus { border-color:var(--accent); }
  .search-bar button { background:var(--accent); color:var(--bg); border:none; padding:12px 22px; border-radius:10px; font-weight:700; cursor:pointer; transition:all 0.2s; }
  .search-bar button:hover { transform:scale(1.03); }
  .orders-table-wrapper { background:var(--card); border:2px solid var(--border); border-radius:14px; overflow:hidden; }
  table { width:100%; border-collapse:collapse; font-size:0.9rem; }
  thead { background:#0f1524; border-bottom:2px solid var(--border); }
  th { text-align:left; padding:14px 16px; color:var(--accent); font-weight:700; font-size:0.8rem; text-transform:uppercase; letter-spacing:0.5px; }
  td { padding:14px 16px; border-bottom:1px solid var(--border); vertical-align:middle; }
  tbody tr:hover { background:var(--card-hover); }
  tbody tr:last-child td { border-bottom:none; }
  .order-id { font-family:monospace; color:var(--accent); font-weight:600; font-size:0.85rem; }
  .ign { font-weight:600; }
  .discord { color:var(--muted); font-size:0.85rem; }
  .method-badge { display:inline-block; padding:4px 10px; border-radius:6px; font-weight:700; font-size:0.75rem; letter-spacing:0.5px; }
  .method-paypal { background:#003087; color:#fff; }
  .method-crypto { background:#26a17b; color:#fff; }
  .status-badge { display:inline-flex; align-items:center; gap:6px; padding:6px 14px; border-radius:20px; font-weight:700; font-size:0.8rem; white-space:nowrap; }
  .status-pending { background:rgba(245,158,11,0.2); color:var(--warning); border:1px solid var(--warning); }
  .status-approved { background:rgba(16,185,129,0.2); color:var(--success); border:1px solid var(--success); }
  .status-rejected { background:rgba(239,68,68,0.2); color:var(--danger); border:1px solid var(--danger); }
  .total-cell { font-weight:800; color:var(--accent); font-family:monospace; font-size:1rem; }
  .actions-cell { display:flex; gap:6px; flex-wrap:wrap; }
  .btn-action { border:none; padding:7px 14px; border-radius:8px; font-weight:700; font-size:0.8rem; cursor:pointer; transition:all 0.15s; font-family:inherit; }
  .btn-accept { background:var(--success); color:#fff; }
  .btn-accept:hover:not(:disabled) { background:#059669; }
  .btn-reject { background:var(--danger); color:#fff; }
  .btn-reject:hover:not(:disabled) { background:#b91c1c; }
  .btn-reset { background:#6366f1; color:#fff; }
  .btn-reset:hover { background:#4f46e5; }
  .btn-action:disabled { opacity:0.4; cursor:not-allowed; }
  .empty-state { text-align:center; padding:60px 20px; color:var(--muted); }
  .toast { position:fixed; bottom:30px; right:30px; background:var(--card); border:2px solid var(--accent); border-radius:12px; padding:16px 22px; font-weight:600; color:var(--text); box-shadow:0 10px 40px rgba(0,0,0,0.5); transform:translateY(100px); opacity:0; transition:all 0.3s; z-index:9999; max-width:350px; }
  .toast.show { transform:translateY(0); opacity:1; }
  .toast.success { border-color:var(--success); }
  .toast.error { border-color:var(--danger); }
  @media (max-width:900px) { table { font-size:0.8rem; } th, td { padding:10px 12px; } h1 { font-size:1.4rem; } h1 span { display:block; margin-left:0; margin-top:4px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>NashmiMC Admin <span>— Order Management</span></h1>
    <div class="refresh-info">Auto-refresh in <strong id="countdown">15</strong>s</div>
  </header>

  <div class="stats-grid">
    <div class="stat-card"><div class="stat-label">Total Orders</div><div class="stat-value" id="statTotal">—</div></div>
    <div class="stat-card"><div class="stat-label">Pending</div><div class="stat-value yellow" id="statPending">—</div></div>
    <div class="stat-card"><div class="stat-label">Approved</div><div class="stat-value green" id="statApproved">—</div></div>
    <div class="stat-card"><div class="stat-label">Rejected</div><div class="stat-value red" id="statRejected">—</div></div>
    <div class="stat-card"><div class="stat-label">Revenue (Approved)</div><div class="stat-value green" id="statRevenue">—</div></div>
  </div>

  <div class="search-bar">
    <input type="text" id="searchInput" placeholder="Search by Order ID, IGN, or Discord...">
    <select id="filterStatus">
      <option value="">All Statuses</option>
      <option value="pending">Pending</option>
      <option value="approved">Approved</option>
      <option value="rejected">Rejected</option>
    </select>
    <button id="refreshBtn">Refresh Now</button>
  </div>

  <div class="orders-table-wrapper">
    <table>
      <thead>
        <tr>
          <th>Order ID</th>
          <th>Player</th>
          <th>Method</th>
          <th>Items</th>
          <th>Total</th>
          <th>Status</th>
          <th>Date</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="ordersTbody">
        <tr><td colspan="8" class="empty-state">Loading...</td></tr>
      </tbody>
    </table>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
var refreshTimer = null;
var countdownTimer = null;
var secondsLeft = 15;
var allOrders = [];

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function showToast(message, type) {
  var t = document.getElementById('toast');
  t.textContent = message;
  t.className = 'toast show ' + (type || '');
  setTimeout(function () { t.className = 'toast'; }, 3000);
}

function statusInfo(status) {
  if (status === 'approved' || status === 'مقبول') return { cls:'status-approved', icon:'\\u2713', label:'Approved' };
  if (status === 'rejected' || status === 'مرفوض') return { cls:'status-rejected', icon:'\\u2715', label:'Rejected' };
  return { cls:'status-pending', icon:'\\u23F1', label:'Pending' };
}

function loadStats() {
  fetch('/api/stats')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) throw new Error(data.error || 'Failed');
      document.getElementById('statTotal').textContent = data.totalOrders || 0;
      var byStatus = data.byStatus || {};
      document.getElementById('statPending').textContent = byStatus['pending'] || 0;
      document.getElementById('statApproved').textContent = byStatus['approved'] || 0;
      document.getElementById('statRejected').textContent = byStatus['rejected'] || 0;
      document.getElementById('statRevenue').textContent = '$' + Number(data.totalRevenue || 0).toFixed(2);
      allOrders = data.recentOrders || [];
      renderOrders();
    })
    .catch(function (err) { console.error(err); showToast('Failed to load orders', 'error'); });
}

function renderOrders() {
  var tbody = document.getElementById('ordersTbody');
  var search = document.getElementById('searchInput').value.trim().toLowerCase();
  var filterStatus = document.getElementById('filterStatus').value;
  var filtered = allOrders;

  if (search) {
    filtered = filtered.filter(function (o) {
      return String(o.id||'').toLowerCase().indexOf(search) !== -1 ||
             String(o.ign||'').toLowerCase().indexOf(search) !== -1 ||
             String(o.discordUser||'').toLowerCase().indexOf(search) !== -1;
    });
  }

  if (filterStatus) {
    filtered = filtered.filter(function (o) {
      if (filterStatus === 'pending') return o.status === 'pending' || o.status === 'قيد الانتظار';
      if (filterStatus === 'approved') return o.status === 'approved' || o.status === 'مقبول';
      if (filterStatus === 'rejected') return o.status === 'rejected' || o.status === 'مرفوض';
      return true;
    });
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No orders match your filters.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(function (o) {
    var si = statusInfo(o.status);
    var methodCls = o.paymentMethod === 'PAYPAL' ? 'method-paypal' : 'method-crypto';
    var itemsStr = Array.isArray(o.items) ? o.items.map(function (i) { return escapeHtml(i.title); }).join('<br>') : '—';
    var dateStr = o.date ? new Date(o.date).toLocaleString('en-GB') : '—';
    var isPending = (o.status === 'pending' || o.status === 'قيد الانتظار');

    return '<tr data-order-id="' + escapeHtml(o.id) + '">' +
      '<td><span class="order-id">' + escapeHtml(o.id) + '</span></td>' +
      '<td><div class="ign">' + escapeHtml(o.ign || '—') + '</div><div class="discord">' + escapeHtml(o.discordUser || '') + '</div></td>' +
      '<td><span class="method-badge ' + methodCls + '">' + escapeHtml(o.paymentMethod || '') + '</span></td>' +
      '<td>' + itemsStr + '</td>' +
      '<td><span class="total-cell">$' + Number(o.total || 0).toFixed(2) + '</span></td>' +
      '<td><span class="status-badge ' + si.cls + '">' + si.icon + ' ' + si.label + '</span></td>' +
      '<td>' + escapeHtml(dateStr) + '</td>' +
      '<td><div class="actions-cell">' +
        '<button class="btn-action btn-accept" data-action="accept" data-id="' + escapeHtml(o.id) + '"' + (isPending ? '' : ' disabled') + '>Accept</button>' +
        '<button class="btn-action btn-reject" data-action="reject" data-id="' + escapeHtml(o.id) + '"' + (isPending ? '' : ' disabled') + '>Reject</button>' +
        '<button class="btn-action btn-reset" data-action="reset" data-id="' + escapeHtml(o.id) + '">Reset</button>' +
      '</div></td>' +
    '</tr>';
  }).join('');

  var buttons = tbody.querySelectorAll('[data-action]');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function () {
      updateOrder(this.dataset.id, this.dataset.action);
    });
  }
}

function updateOrder(orderId, action) {
  if (!confirm('Are you sure you want to ' + action + ' order ' + orderId + '?')) return;
  fetch('/api/admin/update-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: orderId, action: action })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.success) throw new Error(data.error || 'Failed');
      showToast('Order ' + orderId + ' ' + action + 'ed successfully.', 'success');
      loadStats();
    })
    .catch(function (err) { console.error(err); showToast('Failed: ' + err.message, 'error'); });
}

function resetTimers() {
  clearInterval(refreshTimer);
  clearInterval(countdownTimer);
  secondsLeft = 15;
  document.getElementById('countdown').textContent = secondsLeft;

  countdownTimer = setInterval(function () {
    secondsLeft--;
    if (secondsLeft < 0) secondsLeft = 15;
    document.getElementById('countdown').textContent = secondsLeft;
  }, 1000);

  refreshTimer = setInterval(function () { loadStats(); secondsLeft = 15; }, 15000);
}

document.getElementById('refreshBtn').addEventListener('click', function () {
  loadStats();
  secondsLeft = 15;
  showToast('Refreshed.', 'success');
});

document.getElementById('searchInput').addEventListener('input', renderOrders);
document.getElementById('filterStatus').addEventListener('change', renderOrders);

loadStats();
resetTimers();
</script>
</body>
</html>`;

app.get('/admin', adminAuth, (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(ADMIN_HTML);
});

/* =========================================================
   PENDING PAYPAL ORDERS
   ========================================================= */
const pendingPayPalOrders = new Map();

/* =========================================================
   DISCORD INTERACTIONS — Accept / Reject / Reset
   ========================================================= */
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    try {
        const customId = interaction.customId;
        const separatorIndex = customId.indexOf('_');
        if (separatorIndex === -1) return;

        const action = customId.substring(0, separatorIndex);
        const orderId = customId.substring(separatorIndex + 1);

        const order = await findOrderById(orderId);
        if (!order) {
            await interaction.reply({
                content: '⚠️ This order was not found in the database.',
                ephemeral: true
            });
            return;
        }

        let newStatus;

        if (action === 'accept') {
            newStatus = 'approved';
        } else if (action === 'reject') {
            newStatus = 'rejected';
        } else if (action === 'reset') {
            newStatus = 'pending';
        } else {
            return;
        }

        await updateOrderStatus(order.id, newStatus);

        // Update inline message
        let statusEmoji = '⏳';
        let statusText = 'Pending';

        if (newStatus === 'approved') {
            statusEmoji = '✅';
            statusText = 'Approved';
        } else if (newStatus === 'rejected') {
            statusEmoji = '❌';
            statusText = 'Rejected';
        }

        const newStatusLine = `- **Status:** ${statusEmoji} **${statusText}** (by ${interaction.user.tag})`;

        const statusLineRegex = /- \*\*Status:\*\* .*/;
        let newContent = interaction.message.content;

        if (statusLineRegex.test(newContent)) {
            newContent = newContent.replace(statusLineRegex, newStatusLine);
        }

        const components = newStatus === 'pending'
            ? [buildActionButtons(order.id, true)]
            : [];

        await interaction.update({
            content: newContent,
            components
        });

        console.log(`[DISCORD] Order ${order.id} → ${newStatus} by ${interaction.user.tag}`);
    } catch (error) {
        console.error('[DISCORD] Interaction error:', error);
        if (interaction.replied || interaction.deferred) return;
        try {
            await interaction.reply({ content: 'Error while processing this order.', ephemeral: true });
        } catch (_) { /* ignore */ }
    }
});

client.once('ready', async () => {
    console.log('========================================');
    console.log(`[BOT SUCCESS] Logged in as ${client.user.tag}!`);
    console.log(`[SERVER] Port: ${PORT}`);
    console.log(`[SERVER] Frontend: ${FRONTEND_URL || 'CORS *'}`);
    console.log(`[PAYPAL] Mode: ${PAYPAL_MODE}`);
    console.log(`[PAYPAL] Configured: ${Boolean(PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET)}`);
    console.log(`[INVOICE] Canvas: ${createCanvas ? 'OK' : 'DISABLED'}`);
    console.log(`[ADMIN] Password set: ${Boolean(ADMIN_PASSWORD)}`);
    console.log(`[DB] Configured: ${Boolean(DATABASE_URL)}`);

    await initDatabase();

    console.log('========================================');
});

/* =========================================================
   BOOT
   ========================================================= */
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Express listening on 0.0.0.0:${PORT}`);
});

if (!process.env.DISCORD_TOKEN) {
    console.error('[FATAL] DISCORD_TOKEN is missing.');
    process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);

/* =========================================================
   GRACEFUL SHUTDOWN
   ========================================================= */
async function shutdown(signal) {
    console.log(`[SHUTDOWN] Received ${signal}. Cleaning up...`);
    try { if (db) await db.end(); } catch (_) { /* ignore */ }
    try { client.destroy(); } catch (_) { /* ignore */ }
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT EXCEPTION]', error);
});
