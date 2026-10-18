/* =========================================================
   NashmiMC Store — Webhook Only (No Bot)
   ========================================================= */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();

/* =========================================================
   CONFIG
   ========================================================= */
const PORT = Number(process.env.PORT) || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const FRONTEND_URL = process.env.FRONTEND_URL || '';

/* =========================================================
   PRODUCT CATALOG
   ========================================================= */
const PRODUCT_CATALOG = {
    'VIP Rank': 3.99, 'MVP Rank': 9.99, 'MVP+ Rank': 17.99, 'NASHMI Rank': 29.99, 'NASHMI+ Rank': 59.99,
    '100k SMP Money': 0.99, '300k SMP Money': 2.49, '500k SMP Money': 4.99, '1M SMP Money': 9.99, '3M SMP Money': 24.99, '5M SMP Money': 49.99, '10M SMP Money': 74.99,
    '100 SMP Gold': 0.99, '720 SMP Gold': 4.99, '1680 SMP Gold': 9.99, '3600 SMP Gold': 19.99, '6580 SMP Gold': 34.99, '10,000 SMP Gold': 49.99, '16,600 SMP Gold': 74.99, '22,400 SMP Gold': 99.99,
    '100 Box Gold': 0.99, '720 Box Gold': 4.99, '1680 Box Gold': 9.99, '3600 Box Gold': 19.99, '6580 Box Gold': 34.99, '10,000 Box Gold': 49.99, '16,400 Box Gold': 74.99, '22,400 Box Gold': 99.99,
    'DOOM key': 2.49, 'MAGMA Key': 4.99, 'MYTHIC Key': 9.99, 'Mecha Key': 5.00
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
        ssl: DATABASE_URL.includes('render.com') || process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
        max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000
    });
    db.on('error', (err) => console.error('[DB] Unexpected pool error:', err.message));
}

async function initDatabase() {
    if (!db) return;
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id VARCHAR(64) PRIMARY KEY, ign VARCHAR(16) NOT NULL, discord_user VARCHAR(64) NOT NULL,
                payment_method VARCHAR(16) NOT NULL, payment_reference VARCHAR(255), subtotal NUMERIC(10, 2) NOT NULL,
                total NUMERIC(10, 2) NOT NULL, coupon_code VARCHAR(32), items JSONB NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        dbReady = true;
        console.log('[DB] Connected and schema ready.');
    } catch (err) {
        console.error('[DB] Init failed:', err.message);
    }
}

function rowToOrder(row) {
    return {
        id: row.id, ign: row.ign, discordUser: row.discord_user, paymentMethod: row.payment_method,
        paymentReference: row.payment_reference, subtotal: Number(row.subtotal), total: Number(row.total),
        couponCode: row.coupon_code, items: row.items, status: row.status,
        date: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at)
    };
}

async function addOrder(order) {
    if (!dbReady) return false;
    try {
        await db.query(
            `INSERT INTO orders (id, ign, discord_user, payment_method, payment_reference, subtotal, total, coupon_code, items, status) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [order.id, order.ign, order.discordUser, order.paymentMethod, order.paymentReference || null,
             order.subtotal, order.total, order.couponCode || null, JSON.stringify(order.items), order.status]
        );
        return true;
    } catch (err) { console.error('[DB] addOrder failed:', err.message); return false; }
}

async function findOrderById(id) {
    if (!dbReady || !id) return null;
    try {
        const result = await db.query(`SELECT * FROM orders WHERE UPPER(id) = UPPER($1) LIMIT 1`, [String(id)]);
        return result.rows.length === 0 ? null : rowToOrder(result.rows[0]);
    } catch (err) { return null; }
}

async function updateOrderStatus(id, status) {
    if (!dbReady) return false;
    try { const result = await db.query(`UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`, [status, id]); return result.rowCount > 0; } catch (err) { return false; }
}

async function getStats() {
    if (!dbReady) return { ok: false, error: 'DB not ready' };
    try {
        const countersResult = await db.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'pending')::int AS pending, COUNT(*) FILTER (WHERE status = 'approved')::int AS approved, COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected FROM orders`);
        const revenueResult = await db.query(`SELECT COALESCE(SUM(total), 0)::numeric AS revenue FROM orders WHERE status = 'approved'`);
        const recentResult = await db.query(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 100`);
        return { ok: true, totalOrders: countersResult.rows[0].total, byStatus: { pending: countersResult.rows[0].pending, approved: countersResult.rows[0].approved, rejected: countersResult.rows[0].rejected }, totalRevenue: Number(revenueResult.rows[0].revenue), recentOrders: recentResult.rows.map(rowToOrder) };
    } catch (err) { return { ok: false, error: err.message }; }
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ limit: '12mb', extended: true }));

app.use((req, res, next) => {
    if (FRONTEND_URL) { res.header('Access-Control-Allow-Origin', FRONTEND_URL); res.header('Vary', 'Origin'); } else { res.header('Access-Control-Allow-Origin', '*'); }
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const orderLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const trackingLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use(globalLimiter);

function roundMoney(v) { return Number(Number(v).toFixed(2)); }
function createServerOrderId() { return 'NASHMI-' + Math.random().toString(36).substring(2, 8).toUpperCase() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase(); }
function normalizeText(value, maxLength = 200) { return typeof value !== 'string' ? '' : value.trim().replace(/\s+/g, ' ').substring(0, maxLength); }
function isValidIgn(ign) { return typeof ign === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(ign.trim()); }
function isValidDiscordUser(value) { return typeof value === 'string' && /^[a-zA-Z0-9._]{2,32}(#\d{4})?$/.test(value.trim()); }
function isValidCoupon(code) { return typeof code === 'string' && code.trim().toUpperCase() === VALID_COUPON; }
function calculateDiscountedTotal(subtotal, couponCode) { const discount = isValidCoupon(couponCode) ? COUPON_DISCOUNT : 0; return roundMoney(subtotal * (1 - discount)); }

function sanitizeForDiscord(value, maxLength = 300) {
    if (value == null) return '';
    let s = String(value);
    s = s.replace(/[\\`*_{}[\]()#+\-.!|>~]/g, '\\$&');
    s = s.replace(/@(everyone|here|&)/g, '@\u200b$1');
    s = s.replace(/[\r\n]+/g, ' ');
    return s.substring(0, maxLength);
}

function formatDiscordTimestamp(isoString) { try { return `<t:${Math.floor(new Date(isoString).getTime() / 1000)}:F>`; } catch (_) { return 'Unknown'; } }

function parseCustomRankItem(item) {
    if (!item || typeof item.title !== 'string') return null;
    const titleMatch = item.title.trim().match(/^Custom Rank:\s*\[([A-Za-z0-9_-]{1,16})\]$/i);
    if (!titleMatch) return null;
    const details = typeof item.details === 'string' ? item.details : '';
    const pvMatch = details.match(/PVs:\s*(\d+)/i);
    const homesMatch = details.match(/Homes:\s*(\d+)/i);
    const ecMatch = details.match(/EC:\s*([^|]+)/i);
    const anvilMatch = details.match(/Anvil:\s*(Yes|No)/i);
    const tagsMatch = details.match(/Tags:\s*(Yes|No)/i);
    const safeRoomMatch = details.match(/SafeRoom:\s*(Yes|No)/i);
    const colorMatch = details.match(/Color:\s*([^|]+)/i);
    if (!pvMatch || !homesMatch || !ecMatch || !anvilMatch || !tagsMatch || !safeRoomMatch || !colorMatch) return null;
    const pv = Number(pvMatch[1]); const homes = Number(homesMatch[1]);
    if (!Number.isInteger(pv) || pv < 0 || pv > 10 || !Number.isInteger(homes) || homes < 2 || homes > 7) return null;
    const ecText = ecMatch[1].trim(); let ecPrice = 0;
    if (ecText.toLowerCase().includes('normal enderchest')) ecPrice = 2;
    else if (ecText.toLowerCase().includes('double enderchest')) ecPrice = 4;
    const anvil = anvilMatch[1].toLowerCase() === 'yes'; const tags = tagsMatch[1].toLowerCase() === 'yes';
    const safeRoom = safeRoomMatch[1].toLowerCase() === 'yes'; const colorText = colorMatch[1].trim();
    const hasColor = !colorText.toLowerCase().includes('default accent color');
    let price = 5 + (pv * 3) + (homes > 2 ? (homes - 2) * 1.5 : 0) + ecPrice;
    if (anvil) price += 3; if (tags) price += 4; if (safeRoom) price += 5; if (hasColor) price += 3;
    return { title: `Custom Rank: [${titleMatch[1].toUpperCase()}]`, price: roundMoney(price), details: `Rank Name: [${titleMatch[1].toUpperCase()}] | Color: ${colorText} | PVs: ${pv} | Homes: ${homes} | EC: ${ecText} | Anvil: ${anvil ? 'Yes' : 'No'} | Tags: ${tags ? 'Yes' : 'No'} | SafeRoom: ${safeRoom ? 'Yes' : 'No'}` };
}

function parseFixedProductItem(item) {
    if (!item || typeof item.title !== 'string') return null;
    const rawTitle = item.title.trim();
    if (Object.prototype.hasOwnProperty.call(PRODUCT_CATALOG, rawTitle)) return { title: rawTitle, price: PRODUCT_CATALOG[rawTitle] };
    const quantityMatch = rawTitle.match(/^(\d+)\s*x\s*(.+)$/i);
    if (!quantityMatch) return null;
    const quantity = Number(quantityMatch[1]); const productName = quantityMatch[2].trim();
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000 || !ALLOWED_KEY_PRODUCTS.includes(productName)) return null;
    const unitPrice = PRODUCT_CATALOG[productName];
    return { title: `${quantity}x ${productName}`, price: roundMoney(unitPrice * quantity), details: `Quantity: ${quantity} | Unit Price: $${unitPrice.toFixed(2)}` };
}

function validateAndBuildCart(items) {
    if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw new Error('Invalid cart.');
    const validatedItems = [];
    for (const item of items) {
        const fixedItem = parseFixedProductItem(item); if (fixedItem) { validatedItems.push(fixedItem); continue; }
        const customItem = parseCustomRankItem(item); if (customItem) { validatedItems.push(customItem); continue; }
        throw new Error(`Invalid product: ${normalizeText(item?.title || 'Unknown')}`);
    }
    return { items: validatedItems, subtotal: roundMoney(validatedItems.reduce((sum, item) => sum + Number(item.price), 0)) };
}

async function sendDiscordWebhook(order, imageProof = null) {
    if (!DISCORD_WEBHOOK_URL) {
        console.warn('[WEBHOOK] DISCORD_WEBHOOK_URL is not set.');
        return;
    }
    try {
        const content = `🛒 **New Manual Order!**\n` +
            `- **Order ID:** #${order.id}\n` +
            `- **Player IGN:** \`${sanitizeForDiscord(order.ign, 32)}\`\n` +
            `- **Discord:** \`${sanitizeForDiscord(order.discordUser, 64)}\`\n` +
            `- **Payment Method:** ${sanitizeForDiscord(order.paymentMethod, 32)}\n` +
            `- **Total:** $${Number(order.total).toFixed(2)}\n` +
            `- **Date:** ${formatDiscordTimestamp(order.date)}\n\n` +
            `**Items:**\n${order.items.map(item => `• ${sanitizeForDiscord(item.title, 200)} - $${Number(item.price).toFixed(2)}`).join('\n')}`;

        const response = await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content })
        });

        if (!response.ok) {
            console.error('[WEBHOOK] Failed to send Discord message.');
        } else {
            console.log(`[WEBHOOK] Order ${order.id} sent to Discord.`);
        }
    } catch (error) {
        console.error('[WEBHOOK] Error sending to Discord:', error.message);
    }
}

function adminAuth(req, res, next) {
    if (!ADMIN_PASSWORD) return res.status(503).send('Admin password not configured.');
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="NashmiMC Admin"');
        return res.status(401).send('Authentication required.');
    }
    const decoded = Buffer.from(authHeader.substring(6), 'base64').toString('utf8');
    const password = decoded.substring(decoded.indexOf(':') + 1);
    if (password !== ADMIN_PASSWORD) {
        res.set('WWW-Authenticate', 'Basic realm="NashmiMC Admin"');
        return res.status(401).send('Invalid credentials.');
    }
    next();
}

app.get('/health', async (req, res) => {
    let dbStatus = 'disabled';
    if (db) { try { await db.query('SELECT 1'); dbStatus = 'connected'; } catch (err) { dbStatus = 'error'; } }
    res.json({ ok: true, webhook: Boolean(DISCORD_WEBHOOK_URL), db: dbStatus });
});

app.get('/api/stats', trackingLimiter, async (req, res) => res.json(await getStats()));

app.post('/api/new-order', orderLimiter, async (req, res) => {
    try {
        const { ign, discordUser, paymentMethod, items, couponCode, imageProof } = req.body || {};
        
        const method = String(paymentMethod || '').toUpperCase();
        if (!isValidIgn(ign) || !isValidDiscordUser(discordUser) || (method !== 'CRYPTO' && method !== 'PAYPAL') || typeof imageProof !== 'string') {
            return res.status(400).json({ success: false, error: 'Invalid data.' });
        }

        const cart = validateAndBuildCart(items);
        const total = calculateDiscountedTotal(cart.subtotal, couponCode);
        
        const order = { 
            id: createServerOrderId(), 
            ign: ign.trim(), 
            discordUser: normalizeText(discordUser, 100), 
            paymentMethod: method, 
            paymentReference: 'Manual Payment', 
            subtotal: cart.subtotal, 
            total, 
            couponCode: isValidCoupon(couponCode) ? VALID_COUPON : null, 
            items: cart.items, 
            date: new Date().toISOString(), 
            status: 'pending' 
        };
        
        await addOrder(order);
        await sendDiscordWebhook(order, imageProof);
        
        return res.json({ success: true, orderId: order.id, total: order.total, status: order.status });
    } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/orders/:orderId', trackingLimiter, async (req, res) => {
    const order = await findOrderById(normalizeText(req.params.orderId, 100).toUpperCase());
    if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });
    return res.json({ success: true, id: order.id, date: order.date, total: order.total, status: order.status, items: order.items });
});

app.post('/api/admin/update-order', adminAuth, orderLimiter, async (req, res) => {
    try {
        const { orderId, action } = req.body || {};
        if (!orderId || !['accept', 'reject', 'reset'].includes(action)) return res.status(400).json({ success: false, error: 'Invalid request.' });
        const order = await findOrderById(orderId);
        if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });
        const newStatus = action === 'accept' ? 'approved' : action === 'reject' ? 'rejected' : 'pending';
        await updateOrderStatus(order.id, newStatus);
        return res.json({ success: true, orderId: order.id, status: newStatus });
    } catch (error) { return res.status(500).json({ success: false, error: 'Internal error.' }); }
});

const ADMIN_HTML = `<!DOCTYPE html><html><head><title>Admin</title></head><body style="background:#111;color:#fff;font-family:sans-serif;padding:20px;"><h1>Admin</h1><div id="content">Loading...</div><script>fetch('/api/stats').then(r=>r.json()).then(d=>{if(!d.ok)return document.getElementById('content').innerText='Error';let h='<h3>Total Orders: '+d.totalOrders+'</h3><ul>';d.recentOrders.forEach(o=>h+='<li>'+o.id+' - '+o.ign+' - $'+o.total+'</li>');h+='</ul>';document.getElementById('content').innerHTML=h;}).catch(e=>document.getElementById('content').innerText='Error');</script></body></html>`;
app.get('/admin', adminAuth, (req, res) => { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(ADMIN_HTML); });

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Express listening on 0.0.0.0:${PORT}`);
    initDatabase();
});

process.on('SIGTERM', () => console.log('[SHUTDOWN] Received SIGTERM. Ignoring...'));
process.on('SIGINT', () => console.log('[SHUTDOWN] Received SIGINT. Ignoring...'));
process.on('unhandledRejection', (reason) => console.error('[UNHANDLED REJECTION]', reason));
process.on('uncaughtException', (error) => console.error('[UNCAUGHT EXCEPTION]', error));
