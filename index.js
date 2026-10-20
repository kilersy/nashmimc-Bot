/* =========================================================
   NashmiMC Store — PayPal Automatic + Full Admin (Card Fix)
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

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_MODE = (process.env.PAYPAL_MODE || 'live').toLowerCase();
const PAYPAL_BASE_URL = PAYPAL_MODE === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';

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
const VALID_COUPON = 'VIP2026';
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
                status VARCHAR(32) NOT NULL DEFAULT 'pending', 
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

async function sendDiscordWebhook(order) {
    if (!DISCORD_WEBHOOK_URL) return;

    try {
        console.log(`[WEBHOOK] Attempting to send order ${order.id} to Discord...`);
        
        let content = `🛒 **New Order!**\n` +
            `- **Order ID:** #${order.id}\n` +
            `- **Player IGN:** \`${order.ign}\`\n` +
            `- **Discord:** \`${order.discordUser}\`\n` +
            `- **Payment Method:** ${order.paymentMethod}\n` +
            `- **Total:** $${Number(order.total).toFixed(2)}\n\n` +
            `**Items:**\n${order.items.map(item => `• ${item.title} - $${Number(item.price).toFixed(2)}`).join('\n')}`;

        const response = await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content })
        });

        if (!response.ok) {
            console.error(`[WEBHOOK] Failed to send. Status: ${response.status}`);
        } else {
            console.log(`[WEBHOOK] Order ${order.id} sent to Discord.`);
        }
    } catch (error) {
        console.error('[WEBHOOK] Error sending to Discord:', error.message);
    }
}

/* =========================================================
   PAYPAL HELPERS
   ========================================================= */
async function paypalAccessToken() {
    const credentials = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
        method: 'POST', headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials'
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Error('Unable to authenticate with PayPal.');
    return data.access_token;
}

async function paypalCreateOrder(total, internalOrderId) {
    const accessToken = await paypalAccessToken();
    const payload = { intent: 'CAPTURE', purchase_units: [{ reference_id: internalOrderId, amount: { currency_code: 'USD', value: Number(total).toFixed(2) } }] };
    const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': internalOrderId },
        body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.message || 'PayPal could not create the order.');
    return data;
}

async function paypalCaptureOrder(paypalOrderId) {
    const accessToken = await paypalAccessToken();
    const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.message || 'PayPal could not capture the payment.');
    return data;
}

function getCapturedAmount(paypalResponse) {
    const capture = paypalResponse?.purchase_units?.[0]?.payments?.captures?.[0];
    return capture ? { status: capture.status, value: Number(capture?.amount?.value), currency: capture?.amount?.currency_code } : null;
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

/* =========================================================
   ROUTES
   ========================================================= */
app.get('/health', async (req, res) => {
    res.json({ ok: true, webhook: Boolean(DISCORD_WEBHOOK_URL), db: dbReady ? 'connected' : 'error' });
});

app.get('/api/stats', trackingLimiter, async (req, res) => res.json(await getStats()));

app.post('/api/paypal/create-order', orderLimiter, async (req, res) => {
    try {
        const { clientOrderId, ign, discordUser, items, couponCode } = req.body || {};
        if (!isValidIgn(ign) || !isValidDiscordUser(discordUser)) return res.status(400).json({ success: false, error: 'Invalid user details.' });
        const cart = validateAndBuildCart(items);
        const total = calculateDiscountedTotal(cart.subtotal, couponCode);
        if (total <= 0) return res.status(400).json({ success: false, error: 'Invalid total.' });
        const internalOrderId = createServerOrderId();
        const paypalOrder = await paypalCreateOrder(total, internalOrderId);
        if (!paypalOrder?.id) throw new Error('PayPal did not return an order ID.');
        return res.json({ success: true, orderID: paypalOrder.id, total });
    } catch (error) { return res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/paypal/capture-order', orderLimiter, async (req, res) => {
    try {
        const { paypalOrderId, clientOrderId, ign, discordUser, items, couponCode } = req.body || {};
        if (!paypalOrderId) return res.status(400).json({ success: false, error: 'Order ID required.' });
        if (!isValidIgn(ign) || !isValidDiscordUser(discordUser)) return res.status(400).json({ success: false, error: 'Invalid user details.' });

        const existingOrder = await findOrderById(clientOrderId);
        if (existingOrder) {
            return res.json({ success: true, orderId: existingOrder.id, total: existingOrder.total, status: existingOrder.status });
        }

        const paypalResponse = await paypalCaptureOrder(paypalOrderId);
        const capture = getCapturedAmount(paypalResponse);
        
        // تعديل هام: بنقبل حالة COMPLETED أو PENDING
        if (!capture || (capture.status !== 'COMPLETED' && capture.status !== 'PENDING')) {
            throw new Error('Payment not completed or pending.');
        }
        if (capture.currency !== 'USD') throw new Error('Unexpected PayPal currency.');

        const cart = validateAndBuildCart(items);
        const total = calculateDiscountedTotal(cart.subtotal, couponCode);

        if (Number(capture.value) !== Number(total)) throw new Error('Payment amount mismatch.');

        const order = { 
            id: clientOrderId || createServerOrderId(), 
            ign: ign.trim(), 
            discordUser: normalizeText(discordUser, 100), 
            paymentMethod: 'PAYPAL', 
            paymentReference: `PayPal: ${paypalOrderId}`, 
            subtotal: cart.subtotal, 
            total, 
            couponCode: isValidCoupon(couponCode) ? VALID_COUPON : null, 
            items: cart.items, 
            date: new Date().toISOString(), 
            status: 'pending'
        };
        
        await addOrder(order);
        await sendDiscordWebhook(order);

        return res.json({ success: true, orderId: order.id, total: order.total, status: order.status });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
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
  .confirm-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.75); backdrop-filter:blur(6px); display:none; justify-content:center; align-items:center; z-index:10000; padding:20px; }
  .confirm-overlay.open { display:flex; }
  .confirm-modal { background:var(--card); border:2px solid var(--accent); border-radius:18px; padding:32px 28px; width:100%; max-width:480px; box-shadow:0 20px 60px rgba(0,0,0,0.6); text-align:center; animation:popIn 0.25s ease; }
  @keyframes popIn { from { opacity:0; transform:scale(0.9); } to { opacity:1; transform:scale(1); } }
  .confirm-icon { font-size:3rem; margin-bottom:15px; display:block; }
  .confirm-title { font-size:1.4rem; font-weight:800; color:var(--text); margin-bottom:10px; }
  .confirm-message { color:var(--muted); font-size:0.95rem; line-height:1.6; margin-bottom:25px; }
  .confirm-message strong { color:var(--accent); }
  .confirm-actions { display:flex; gap:12px; justify-content:center; }
  .btn-confirm-cancel, .btn-confirm-ok { padding:12px 26px; border:none; border-radius:10px; font-weight:800; font-size:0.95rem; cursor:pointer; transition:all 0.2s; font-family:inherit; min-width:120px; }
  .btn-confirm-cancel { background:transparent; border:2px solid var(--border); color:var(--text); }
  .btn-confirm-cancel:hover { background:var(--card-hover); border-color:var(--muted); }
  .btn-confirm-ok { color:#fff; }
  .btn-confirm-ok.accept { background:var(--success); }
  .btn-confirm-ok.accept:hover { background:#059669; }
  .btn-confirm-ok.reject { background:var(--danger); }
  .btn-confirm-ok.reject:hover { background:#b91c1c; }
  .btn-confirm-ok.reset { background:#6366f1; }
  .btn-confirm-ok.reset:hover { background:#4f46e5; }
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

<div class="confirm-overlay" id="confirmOverlay">
  <div class="confirm-modal">
    <span class="confirm-icon" id="confirmIcon">⚠️</span>
    <div class="confirm-title" id="confirmTitle">Are you sure?</div>
    <div class="confirm-message" id="confirmMessage">Please confirm this action.</div>
    <div class="confirm-actions">
      <button class="btn-confirm-cancel" id="confirmCancelBtn">Cancel</button>
      <button class="btn-confirm-ok" id="confirmOkBtn">Confirm</button>
    </div>
  </div>
</div>

<script>
var refreshTimer = null;
var countdownTimer = null;
var secondsLeft = 15;
var allOrders = [];
var pendingConfirm = null;

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

    return '<tr data-order-id="' + escapeHtml(o.id) + '">' +
      '<td><span class="order-id">' + escapeHtml(o.id) + '</span></td>' +
      '<td><div class="ign">' + escapeHtml(o.ign || '—') + '</div><div class="discord">' + escapeHtml(o.discordUser || '') + '</div></td>' +
      '<td><span class="method-badge ' + methodCls + '">' + escapeHtml(o.paymentMethod || '') + '</span></td>' +
      '<td>' + itemsStr + '</td>' +
      '<td><span class="total-cell">$' + Number(o.total || 0).toFixed(2) + '</span></td>' +
      '<td><span class="status-badge ' + si.cls + '">' + si.icon + ' ' + si.label + '</span></td>' +
      '<td>' + escapeHtml(dateStr) + '</td>' +
      '<td><div class="actions-cell">' +
        '<button class="btn-action btn-accept" data-action="accept" data-id="' + escapeHtml(o.id) + '">Accept</button>' +
        '<button class="btn-action btn-reject" data-action="reject" data-id="' + escapeHtml(o.id) + '">Reject</button>' +
        '<button class="btn-action btn-reset" data-action="reset" data-id="' + escapeHtml(o.id) + '">Reset</button>' +
      '</div></td>' +
    '</tr>';
  }).join('');

  var buttons = tbody.querySelectorAll('[data-action]');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function () {
      askConfirm(this.dataset.id, this.dataset.action);
    });
  }
}

function askConfirm(orderId, action) {
  var icon = '⚠️';
  var title = 'Are you sure?';
  var message = '';
  var btnLabel = 'Confirm';

  if (action === 'accept') {
    icon = '✅';
    title = 'Accept this order?';
    message = 'You are about to <strong>Accept</strong> order <strong>' + escapeHtml(orderId) + '</strong>. This will mark it as Approved.';
    btnLabel = 'Accept';
  } else if (action === 'reject') {
    icon = '❌';
    title = 'Reject this order?';
    message = 'You are about to <strong>Reject</strong> order <strong>' + escapeHtml(orderId) + '</strong>. This will mark it as Rejected.';
    btnLabel = 'Reject';
  } else if (action === 'reset') {
    icon = '🔄';
    title = 'Reset this order?';
    message = 'You are about to <strong>Reset</strong> order <strong>' + escapeHtml(orderId) + '</strong>. This will set it back to Pending.';
    btnLabel = 'Reset';
  }

  document.getElementById('confirmIcon').textContent = icon;
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').innerHTML = message;

  var okBtn = document.getElementById('confirmOkBtn');
  okBtn.textContent = btnLabel;
  okBtn.className = 'btn-confirm-ok ' + action;

  pendingConfirm = { orderId: orderId, action: action };

  document.getElementById('confirmOverlay').classList.add('open');
}

function closeConfirm() {
  document.getElementById('confirmOverlay').classList.remove('open');
  pendingConfirm = null;
}

function executeConfirm() {
  if (!pendingConfirm) return;
  var orderId = pendingConfirm.orderId;
  var action = pendingConfirm.action;
  closeConfirm();

  fetch('/api/admin/update-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: orderId, action: action })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.success) throw new Error(data.error || 'Failed');
      var verb = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'reset';
      showToast('Order ' + orderId + ' ' + verb + ' successfully.', 'success');
      loadStats();
    })
    .catch(function (err) { console.error(err); showToast('Failed: ' + err.message, 'error'); });
}

document.getElementById('confirmOkBtn').addEventListener('click', executeConfirm);
document.getElementById('confirmCancelBtn').addEventListener('click', closeConfirm);
document.getElementById('confirmOverlay').addEventListener('click', function (e) {
  if (e.target === this) closeConfirm();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeConfirm();
});

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

app.get('/admin', adminAuth, (req, res) => { res.set('Content-Type', 'text/html; charset=utf-8'); res.send(ADMIN_HTML); });

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Express listening on 0.0.0.0:${PORT}`);
    initDatabase();
});

process.on('SIGTERM', () => console.log('[SHUTDOWN] Received SIGTERM. Ignoring...'));
process.on('SIGINT', () => console.log('[SHUTDOWN] Received SIGINT. Ignoring...'));
process.on('unhandledRejection', (reason) => console.error('[UNHANDLED REJECTION]', reason));
process.on('uncaughtException', (error) => console.error('[UNCAUGHT EXCEPTION]', error));
