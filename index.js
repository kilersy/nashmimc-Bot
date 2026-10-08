/* =========================================================
   NashmiMC Store Bot — Production Build v4
   - PostgreSQL persistence (replaces JSON file)
   - Auto-invoice image for PayPal
   - USDT payment proof images
   - Full sanitization + rate limiting
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
                status            VARCHAR(32) NOT NULL DEFAULT 'قيد الانتظار',
                paypal_order_id   VARCHAR(128),
                created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

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

async function getStats() {
    if (!dbReady) {
        return { ok: false, error: 'DB not ready' };
    }

    try {
        const totalResult = await db.query('SELECT COUNT(*)::int AS count FROM orders');
        const statusResult = await db.query(
            `SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status`
        );
        const revenueResult = await db.query(
            `SELECT COALESCE(SUM(total), 0)::numeric AS revenue
             FROM orders WHERE status = 'مقبول'`
        );
        const recentResult = await db.query(
            `SELECT * FROM orders ORDER BY created_at DESC LIMIT 10`
        );

        const byStatus = {};
        statusResult.rows.forEach(r => {
            byStatus[r.status] = r.count;
        });

        return {
            ok: true,
            totalOrders: totalResult.rows[0].count,
            byStatus,
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
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many order attempts. Please wait a minute.' }
});

const trackingLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
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

    return (
        `🛒 **New Order from Nashmi Store!**\n` +
        `- **Order ID:** #${order.id}\n` +
        `- **Player IGN:** \`${safeIgn}\`\n` +
        `- **Discord:** \`${safeDiscord}\`\n` +
        `- **Payment Method:** ${safeMethod}\n` +
        `- **Total:** $${Number(order.total).toFixed(2)}\n` +
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

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`accept_${order.id}`)
            .setLabel('✅ قبول')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`reject_${order.id}`)
            .setLabel('❌ رفض')
            .setStyle(ButtonStyle.Danger)
    );

    await channel.send({
        content: buildOrderMessage(order),
        components: [row],
        allowedMentions: { parse: [] }
    });

    console.log(`[DISCORD] Order ${order.id} posted.`);
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
        db: dbStatus,
        ordersCount: dbOrders
    });
});

/* =========================================================
   GET /api/stats (admin)
   ========================================================= */
app.get('/api/stats', trackingLimiter, async (req, res) => {
    const stats = await getStats();
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
            status: 'قيد الانتظار'
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
            status: 'قيد الانتظار',
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
   DISCORD INTERACTIONS
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

        if (action === 'accept') {
            await updateOrderStatus(order.id, 'مقبول');
            await interaction.update({
                content: interaction.message.content.replace(
                    '⏳ Pending',
                    `✅ **Accepted** (by ${interaction.user.tag})`
                ),
                components: []
            });
            console.log(`[ORDER] ${order.id} accepted by ${interaction.user.tag}`);
            return;
        }

        if (action === 'reject') {
            await updateOrderStatus(order.id, 'مرفوض');
            await interaction.update({
                content: interaction.message.content.replace(
                    '⏳ Pending',
                    `❌ **Rejected** (by ${interaction.user.tag})`
                ),
                components: []
            });
            console.log(`[ORDER] ${order.id} rejected by ${interaction.user.tag}`);
            return;
        }
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
    try {
        if (db) await db.end();
    } catch (_) { /* ignore */ }
    try {
        client.destroy();
    } catch (_) { /* ignore */ }
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
