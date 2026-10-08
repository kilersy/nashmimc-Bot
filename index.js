const {
    Client,
    GatewayIntentBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const express = require('express');

const app = express();

/* =========================================================
   CONFIGURATION
   ========================================================= */

const PORT = Number(process.env.PORT) || 10000;

const ADMIN_CHANNEL_ID =
    process.env.ADMIN_CHANNEL_ID ||
    '1551626123585130546';

const PAYPAL_CLIENT_ID =
    process.env.PAYPAL_CLIENT_ID || '';

const PAYPAL_CLIENT_SECRET =
    process.env.PAYPAL_CLIENT_SECRET || '';

const PAYPAL_MODE =
    (process.env.PAYPAL_MODE || 'live').toLowerCase();

const PAYPAL_BASE_URL =
    PAYPAL_MODE === 'sandbox'
        ? 'https://api-m.sandbox.paypal.com'
        : 'https://api-m.paypal.com';

const FRONTEND_URL =
    process.env.FRONTEND_URL || '';

/* =========================================================
   EXPRESS
   ========================================================= */

app.use(
    express.json({
        limit: '50mb'
    })
);

app.use(
    express.urlencoded({
        limit: '50mb',
        extended: true
    })
);

/*
 * CORS
 *
 * If FRONTEND_URL exists, only that website is allowed.
 * Otherwise "*" is used for initial setup.
 */
app.use((req, res, next) => {
    if (FRONTEND_URL) {
        res.header(
            'Access-Control-Allow-Origin',
            FRONTEND_URL
        );

        res.header(
            'Vary',
            'Origin'
        );
    } else {
        res.header(
            'Access-Control-Allow-Origin',
            '*'
        );
    }

    res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept'
    );

    res.header(
        'Access-Control-Allow-Methods',
        'GET, POST, OPTIONS'
    );

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
});

/* =========================================================
   DISCORD CLIENT
   ========================================================= */

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});

/* =========================================================
   DATABASE
   ========================================================= */

/*
 * Temporary in-memory storage.
 *
 * Later we can move this to a real database so orders survive
 * Render restarts and redeployments.
 */
let ordersDatabase = [];

/*
 * Temporary PayPal pending orders.
 *
 * Stores server-calculated information between PayPal
 * create-order and capture-order.
 */
const pendingPayPalOrders = new Map();

/* =========================================================
   PRODUCT CATALOG
   ========================================================= */

/*
 * IMPORTANT:
 * Prices here are the authoritative server prices.
 *
 * We NEVER trust the price sent by the browser.
 */
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

/* =========================================================
   GENERAL HELPERS
   ========================================================= */

function roundMoney(value) {
    return Number(
        Number(value).toFixed(2)
    );
}

function createServerOrderId() {
    return (
        'NASHMI-' +
        Math.random()
            .toString(36)
            .substring(2, 8)
            .toUpperCase() +
        '-' +
        Math.random()
            .toString(36)
            .substring(2, 8)
            .toUpperCase()
    );
}

function normalizeText(value, maxLength = 200) {
    if (typeof value !== 'string') {
        return '';
    }

    return value
        .trim()
        .replace(/\s+/g, ' ')
        .substring(0, maxLength);
}

function isValidIgn(ign) {
    return (
        typeof ign === 'string' &&
        /^[A-Za-z0-9_]{1,16}$/.test(
            ign.trim()
        )
    );
}

function isValidDiscordUser(value) {
    if (typeof value !== 'string') {
        return false;
    }

    const cleaned = value.trim();

    return (
        cleaned.length >= 2 &&
        cleaned.length <= 100
    );
}

function isValidCoupon(code) {
    return (
        typeof code === 'string' &&
        code.trim().toUpperCase() ===
            'NASHMI2026'
    );
}

function calculateDiscountedTotal(
    subtotal,
    couponCode
) {
    const discount =
        isValidCoupon(couponCode)
            ? 0.15
            : 0;

    return roundMoney(
        subtotal *
            (1 - discount)
    );
}

/* =========================================================
   CUSTOM RANK VALIDATION
   ========================================================= */

function parseCustomRankItem(item) {
    if (
        !item ||
        typeof item.title !== 'string'
    ) {
        return null;
    }

    const title =
        item.title.trim();

    const titleMatch =
        title.match(
            /^Custom Rank:\s*\[([A-Za-z0-9_-]{1,16})\]$/i
        );

    if (!titleMatch) {
        return null;
    }

    const rankName =
        titleMatch[1].toUpperCase();

    const details =
        typeof item.details === 'string'
            ? item.details
            : '';

    const pvMatch =
        details.match(
            /PVs:\s*(\d+)/i
        );

    const homesMatch =
        details.match(
            /Homes:\s*(\d+)/i
        );

    const ecMatch =
        details.match(
            /EC:\s*([^|]+)/i
        );

    const anvilMatch =
        details.match(
            /Anvil:\s*(Yes|No)/i
        );

    const tagsMatch =
        details.match(
            /Tags:\s*(Yes|No)/i
        );

    const safeRoomMatch =
        details.match(
            /SafeRoom:\s*(Yes|No)/i
        );

    const colorMatch =
        details.match(
            /Color:\s*([^|]+)/i
        );

    if (
        !pvMatch ||
        !homesMatch ||
        !ecMatch ||
        !anvilMatch ||
        !tagsMatch ||
        !safeRoomMatch ||
        !colorMatch
    ) {
        return null;
    }

    const pv =
        Number(pvMatch[1]);

    const homes =
        Number(homesMatch[1]);

    if (
        !Number.isInteger(pv) ||
        pv < 0 ||
        pv > 10
    ) {
        return null;
    }

    if (
        !Number.isInteger(homes) ||
        homes < 2 ||
        homes > 7
    ) {
        return null;
    }

    const ecText =
        ecMatch[1]
            .trim();

    let ecPrice = 0;

    if (
        ecText
            .toLowerCase()
            .includes(
                'normal enderchest'
            )
    ) {
        ecPrice = 2;
    } else if (
        ecText
            .toLowerCase()
            .includes(
                'double enderchest'
            )
    ) {
        ecPrice = 4;
    } else if (
        !ecText
            .toLowerCase()
            .includes('none')
    ) {
        return null;
    }

    const anvil =
        anvilMatch[1]
            .toLowerCase() === 'yes';

    const tags =
        tagsMatch[1]
            .toLowerCase() === 'yes';

    const safeRoom =
        safeRoomMatch[1]
            .toLowerCase() === 'yes';

    const colorText =
        colorMatch[1]
            .trim();

    const hasColor =
        !colorText
            .toLowerCase()
            .includes(
                'default accent color'
            );

    let price = 5;

    price += pv * 3;

    if (homes > 2) {
        price +=
            (homes - 2) * 1.5;
    }

    price += ecPrice;

    if (anvil) {
        price += 3;
    }

    if (tags) {
        price += 4;
    }

    if (safeRoom) {
        price += 5;
    }

    if (hasColor) {
        price += 3;
    }

    price = roundMoney(price);

    const rebuiltDetails =
        `Rank Name: [${rankName}] | ` +
        `Color: ${colorText} | ` +
        `PVs: ${pv} | ` +
        `Homes: ${homes} | ` +
        `EC: ${ecText} | ` +
        `Anvil: ${anvil ? 'Yes' : 'No'} | ` +
        `Tags: ${tags ? 'Yes' : 'No'} | ` +
        `SafeRoom: ${safeRoom ? 'Yes' : 'No'}`;

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
    if (
        !item ||
        typeof item.title !== 'string'
    ) {
        return null;
    }

    const rawTitle =
        item.title.trim();

    if (
        Object.prototype.hasOwnProperty.call(
            PRODUCT_CATALOG,
            rawTitle
        )
    ) {
        return {
            title: rawTitle,
            price:
                PRODUCT_CATALOG[
                    rawTitle
                ]
        };
    }

    /*
     * Quantity products:
     * 1x DOOM key
     * 2x MAGMA Key
     * 5x MYTHIC Key
     * 3x Mecha Key
     */
    const quantityMatch =
        rawTitle.match(
            /^(\d+)\s*x\s*(.+)$/i
        );

    if (!quantityMatch) {
        return null;
    }

    const quantity =
        Number(quantityMatch[1]);

    const productName =
        quantityMatch[2].trim();

    if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 1000
    ) {
        return null;
    }

    const allowedKeyProducts = [
        'DOOM key',
        'MAGMA Key',
        'MYTHIC Key',
        'Mecha Key'
    ];

    if (
        !allowedKeyProducts.includes(
            productName
        )
    ) {
        return null;
    }

    const unitPrice =
        PRODUCT_CATALOG[
            productName
        ];

    return {
        title:
            `${quantity}x ${productName}`,

        price:
            roundMoney(
                unitPrice *
                    quantity
            ),

        details:
            `Quantity: ${quantity} | Unit Price: $${unitPrice.toFixed(2)}`
    };
}

/* =========================================================
   SERVER-SIDE CART VALIDATION
   ========================================================= */

function validateAndBuildCart(
    items
) {
    if (!Array.isArray(items)) {
        throw new Error(
            'Invalid cart.'
        );
    }

    if (
        items.length < 1 ||
        items.length > 50
    ) {
        throw new Error(
            'Cart contains an invalid number of items.'
        );
    }

    const validatedItems = [];

    for (const item of items) {
        const fixedItem =
            parseFixedProductItem(
                item
            );

        if (fixedItem) {
            validatedItems.push(
                fixedItem
            );
            continue;
        }

        const customItem =
            parseCustomRankItem(
                item
            );

        if (customItem) {
            validatedItems.push(
                customItem
            );
            continue;
        }

        throw new Error(
            `Invalid product: ${
                normalizeText(
                    item?.title ||
                        'Unknown'
                )
            }`
        );
    }

    const subtotal =
        roundMoney(
            validatedItems.reduce(
                (sum, item) =>
                    sum +
                    Number(item.price),
                0
            )
        );

    return {
        items: validatedItems,
        subtotal
    };
}

/* =========================================================
   DISCORD HELPERS
   ========================================================= */

async function fetchAdminChannel() {
    const channel =
        await client.channels.fetch(
            ADMIN_CHANNEL_ID
        );

    if (!channel) {
        throw new Error(
            'Admin Discord channel was not found.'
        );
    }

    if (
        !channel.isTextBased()
    ) {
        throw new Error(
            'Admin Discord channel is not text based.'
        );
    }

    return channel;
}

function buildOrderMessage(order) {
    const itemsList =
        order.items
            .map(item => {
                const details =
                    item.details
                        ? `\n  [Details: ${item.details}]`
                        : '';

                return (
                    `• ${item.title} - $${Number(item.price).toFixed(2)}` +
                    details
                );
            })
            .join('\n');

    return (
        `🛒 **طلب شراء جديد من متجر نشمي!**\n` +
        `- **رقم الطلب:** #${order.id}\n` +
        `- **اسم اللاعب (IGN):** ${order.ign}\n` +
        `- **حساب ديسكورد:** ${order.discordUser}\n` +
        `- **طريقة الدفع:** ${order.paymentMethod}\n` +
        `- **المجموع:** $${Number(order.total).toFixed(2)}\n` +
        `- **الحالة:** ⏳ قيد الانتظار\n` +
        `- **المرجع:** ${order.paymentReference || 'N/A'}\n\n` +
        `**المنتجات:**\n${itemsList}`
    );
}

async function sendPaymentProof(
    channel,
    imageProof
) {
    if (
        typeof imageProof !== 'string' ||
        !imageProof.startsWith(
            'data:image/'
        ) ||
        !imageProof.includes(
            ';base64,'
        )
    ) {
        return false;
    }

    const match =
        imageProof.match(
            /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i
        );

    if (!match) {
        throw new Error(
            'Invalid payment proof image format.'
        );
    }

    const extension =
        match[1].toLowerCase() === 'jpeg' ||
        match[1].toLowerCase() === 'jpg'
            ? 'jpg'
            : match[1].toLowerCase();

    const base64Data =
        match[2];

    const buffer =
        Buffer.from(
            base64Data,
            'base64'
        );

    /*
     * Keep the decoded image below Discord's
     * common 10 MB attachment limit.
     */
    if (
        buffer.length >
        7.5 * 1024 * 1024
    ) {
        throw new Error(
            'Payment proof image is too large.'
        );
    }

    await channel.send({
        files: [
            {
                attachment:
                    buffer,

                name:
                    `payment_proof.${extension}`
            }
        ],

        allowedMentions: {
            parse: []
        }
    });

    return true;
}

async function createDiscordOrder(
    order,
    imageProof = null
) {
    const channel =
        await fetchAdminChannel();

    if (imageProof) {
        try {
            await sendPaymentProof(
                channel,
                imageProof
            );

            console.log(
                '[DISCORD] Payment proof uploaded.'
            );
        } catch (error) {
            console.error(
                '[DISCORD] Failed to upload payment proof:',
                error.message
            );
        }
    }

    const row =
        new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(
                        `accept_${order.id}`
                    )
                    .setLabel(
                        '✅ قبول'
                    )
                    .setStyle(
                        ButtonStyle.Success
                    ),

                new ButtonBuilder()
                    .setCustomId(
                        `reject_${order.id}`
                    )
                    .setLabel(
                        '❌ رفض'
                    )
                    .setStyle(
                        ButtonStyle.Danger
                    )
            );

    await channel.send({
        content:
            buildOrderMessage(
                order
            ),

        components: [
            row
        ],

        allowedMentions: {
            parse: []
        }
    });

    console.log(
        `[DISCORD] Order ${order.id} posted successfully.`
    );
}

/* =========================================================
   PAYPAL HELPERS
   ========================================================= */

function ensurePayPalConfigured() {
    if (
        !PAYPAL_CLIENT_ID ||
        !PAYPAL_CLIENT_SECRET
    ) {
        throw new Error(
            'PayPal environment variables are not configured on Render.'
        );
    }
}

async function paypalAccessToken() {
    ensurePayPalConfigured();

    const credentials =
        Buffer.from(
            `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
        ).toString(
            'base64'
        );

    const response =
        await fetch(
            `${PAYPAL_BASE_URL}/v1/oauth2/token`,
            {
                method: 'POST',

                headers: {
                    'Authorization':
                        `Basic ${credentials}`,

                    'Content-Type':
                        'application/x-www-form-urlencoded'
                },

                body:
                    'grant_type=client_credentials'
            }
        );

    const data =
        await response.json();

    if (
        !response.ok ||
        !data.access_token
    ) {
        console.error(
            '[PAYPAL] OAuth error:',
            data
        );

        throw new Error(
            'Unable to authenticate with PayPal.'
        );
    }

    return data.access_token;
}

async function paypalCreateOrder(
    total,
    internalOrderId
) {
    const accessToken =
        await paypalAccessToken();

    const payload = {
        intent: 'CAPTURE',

        purchase_units: [
            {
                reference_id:
                    internalOrderId,

                amount: {
                    currency_code:
                        'USD',

                    value:
                        Number(total)
                            .toFixed(2)
                }
            }
        ]
    };

    const response =
        await fetch(
            `${PAYPAL_BASE_URL}/v2/checkout/orders`,
            {
                method: 'POST',

                headers: {
                    'Authorization':
                        `Bearer ${accessToken}`,

                    'Content-Type':
                        'application/json',

                    'PayPal-Request-Id':
                        internalOrderId
                },

                body:
                    JSON.stringify(
                        payload
                    )
            }
        );

    const data =
        await response.json();

    if (!response.ok) {
        console.error(
            '[PAYPAL] Create order error:',
            data
        );

        throw new Error(
            data?.message ||
            'PayPal could not create the order.'
        );
    }

    return data;
}

async function paypalCaptureOrder(
    paypalOrderId
) {
    const accessToken =
        await paypalAccessToken();

    const response =
        await fetch(
            `${PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(
                paypalOrderId
            )}/capture`,
            {
                method: 'POST',

                headers: {
                    'Authorization':
                        `Bearer ${accessToken}`,

                    'Content-Type':
                        'application/json'
                },

                body:
                    JSON.stringify({})
            }
        );

    const data =
        await response.json();

    if (!response.ok) {
        console.error(
            '[PAYPAL] Capture error:',
            data
        );

        throw new Error(
            data?.message ||
            'PayPal could not capture the payment.'
        );
    }

    return data;
}

function getCapturedAmount(
    paypalResponse
) {
    const capture =
        paypalResponse
            ?.purchase_units?.[0]
            ?.payments
            ?.captures?.[0];

    if (!capture) {
        return null;
    }

    return {
        status:
            capture.status,

        value:
            Number(
                capture?.amount?.value
            ),

        currency:
            capture?.amount
                ?.currency_code
    };
}

/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get(
    '/health',
    (req, res) => {
        res.json({
            ok: true,

            bot:
                client.isReady(),

            paypal:
                Boolean(
                    PAYPAL_CLIENT_ID &&
                    PAYPAL_CLIENT_SECRET
                ),

            mode:
                PAYPAL_MODE
        });
    }
);

/* =========================================================
   STANDARD / CRYPTO ORDER
   ========================================================= */

app.post(
    '/api/new-order',
    async (req, res) => {
        console.log(
            '----------------------------------------'
        );

        console.log(
            '[API] New order received.'
        );

        try {
            const {
                ign,
                discordUser,
                paymentMethod,
                items,
                couponCode,
                imageProof
            } = req.body || {};

            if (!isValidIgn(ign)) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Invalid Minecraft username.'
                    });
            }

            if (
                !isValidDiscordUser(
                    discordUser
                )
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Invalid Discord username.'
                    });
            }

            const method =
                String(
                    paymentMethod || ''
                )
                    .trim()
                    .toUpperCase();

            /*
             * This endpoint is intentionally for
             * manual/crypto orders only.
             */
            if (
                method !== 'CRYPTO'
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Invalid payment method for this endpoint.'
                    });
            }

            /*
             * Crypto orders require payment proof.
             */
            if (
                typeof imageProof !== 'string' ||
                !imageProof.startsWith(
                    'data:image/'
                )
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Payment proof image is required for Crypto orders.'
                    });
            }

            const cart =
                validateAndBuildCart(
                    items
                );

            const total =
                calculateDiscountedTotal(
                    cart.subtotal,
                    couponCode
                );

            const orderId =
                createServerOrderId();

            const now =
                new Date();

            const order = {
                id:
                    orderId,

                ign:
                    ign.trim(),

                discordUser:
                    normalizeText(
                        discordUser,
                        100
                    ),

                paymentMethod:
                    'CRYPTO',

                paymentReference:
                    'Manual Crypto Payment',

                subtotal:
                    cart.subtotal,

                total,

                couponCode:
                    isValidCoupon(
                        couponCode
                    )
                        ? 'NASHMI2026'
                        : null,

                items:
                    cart.items,

                date:
                    now.toISOString(),

                status:
                    'قيد الانتظار'
            };

            ordersDatabase.unshift(
                order
            );

            await createDiscordOrder(
                order,
                imageProof
            );

            console.log(
                `[SUCCESS] Crypto order ${order.id}`
            );

            return res.json({
                success: true,

                orderId:
                    order.id,

                total:
                    order.total,

                status:
                    order.status
            });

        } catch (error) {
            console.error(
                '[CRITICAL] /api/new-order:',
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    error:
                        error.message ||
                        'Server error while processing order.'
                });
        }
    }
);

/* =========================================================
   PAYPAL CREATE ORDER
   ========================================================= */

app.post(
    '/api/paypal/create-order',
    async (req, res) => {
        console.log(
            '[PAYPAL] Creating server-side PayPal order.'
        );

        try {
            const {
                clientOrderId,
                ign,
                discordUser,
                items,
                couponCode
            } = req.body || {};

            if (!isValidIgn(ign)) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Invalid Minecraft username.'
                    });
            }

            if (
                !isValidDiscordUser(
                    discordUser
                )
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Invalid Discord username.'
                    });
            }

            const cart =
                validateAndBuildCart(
                    items
                );

            const total =
                calculateDiscountedTotal(
                    cart.subtotal,
                    couponCode
                );

            if (
                total <= 0
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'Invalid payment total.'
                    });
            }

            const internalOrderId =
                createServerOrderId();

            const paypalOrder =
                await paypalCreateOrder(
                    total,
                    internalOrderId
                );

            if (
                !paypalOrder?.id
            ) {
                throw new Error(
                    'PayPal did not return an order ID.'
                );
            }

            /*
             * Store the server-validated cart.
             * We do NOT trust the browser during capture.
             */
            pendingPayPalOrders.set(
                paypalOrder.id,
                {
                    internalOrderId,

                    clientOrderId:
                        normalizeText(
                            clientOrderId,
                            100
                        ),

                    ign:
                        ign.trim(),

                    discordUser:
                        normalizeText(
                            discordUser,
                            100
                        ),

                    items:
                        cart.items,

                    subtotal:
                        cart.subtotal,

                    total,

                    couponCode:
                        isValidCoupon(
                            couponCode
                        )
                            ? 'NASHMI2026'
                            : null,

                    createdAt:
                        Date.now()
                }
            );

            console.log(
                `[PAYPAL] Created ${paypalOrder.id} for ${total.toFixed(
                    2
                )} USD`
            );

            return res.json({
                success: true,

                orderID:
                    paypalOrder.id,

                total
            });

        } catch (error) {
            console.error(
                '[PAYPAL] Create order failed:',
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    error:
                        error.message ||
                        'Unable to create PayPal order.'
                });
        }
    }
);

/* =========================================================
   PAYPAL CAPTURE ORDER
   ========================================================= */

app.post(
    '/api/paypal/capture-order',
    async (req, res) => {
        console.log(
            '[PAYPAL] Capturing PayPal order.'
        );

        try {
            const {
                paypalOrderId,
                imageProof
            } = req.body || {};

            if (
                typeof paypalOrderId !==
                'string' ||
                !paypalOrderId.trim()
            ) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            'PayPal order ID is required.'
                    });
            }

            const pending =
                pendingPayPalOrders.get(
                    paypalOrderId
                );

            if (!pending) {
                return res
                    .status(404)
                    .json({
                        success: false,
                        error:
                            'PayPal order session was not found or has expired. Please start the payment again.'
                    });
            }

            /*
             * Prevent stale pending sessions.
             */
            const maxPendingAge =
                30 * 60 * 1000;

            if (
                Date.now() -
                    pending.createdAt >
                maxPendingAge
            ) {
                pendingPayPalOrders.delete(
                    paypalOrderId
                );

                return res
                    .status(410)
                    .json({
                        success: false,
                        error:
                            'PayPal payment session expired. Please start again.'
                    });
            }

            const paypalResponse =
                await paypalCaptureOrder(
                    paypalOrderId
                );

            const capture =
                getCapturedAmount(
                    paypalResponse
                );

            if (!capture) {
                throw new Error(
                    'PayPal capture information was not returned.'
                );
            }

            if (
                capture.status !==
                'COMPLETED'
            ) {
                throw new Error(
                    `PayPal payment is not completed. Current status: ${capture.status}`
                );
            }

            if (
                capture.currency !==
                'USD'
            ) {
                throw new Error(
                    'Unexpected PayPal currency.'
                );
            }

            if (
                Number(
                    capture.value
                ) !==
                Number(
                    pending.total
                )
            ) {
                console.error(
                    '[PAYPAL] Amount mismatch:',
                    {
                        expected:
                            pending.total,

                        received:
                            capture.value
                    }
                );

                throw new Error(
                    'PayPal payment amount does not match the order total.'
                );
            }

            const order = {
                id:
                    pending.internalOrderId,

                ign:
                    pending.ign,

                discordUser:
                    pending.discordUser,

                paymentMethod:
                    'PAYPAL',

                paymentReference:
                    `PayPal Order: ${paypalOrderId}`,

                subtotal:
                    pending.subtotal,

                total:
                    pending.total,

                couponCode:
                    pending.couponCode,

                items:
                    pending.items,

                date:
                    new Date()
                        .toISOString(),

                status:
                    'قيد الانتظار',

                paypalOrderId
            };

            ordersDatabase.unshift(
                order
            );

            /*
             * Payment has been verified by PayPal
             * before the Discord order is created.
             */
            await createDiscordOrder(
                order,
                imageProof || null
            );

            pendingPayPalOrders.delete(
                paypalOrderId
            );

            console.log(
                `[SUCCESS] PayPal payment completed for ${order.id}`
            );

            return res.json({
                success: true,

                orderId:
                    order.id,

                paypalOrderId,

                total:
                    order.total,

                status:
                    order.status
            });

        } catch (error) {
            console.error(
                '[PAYPAL] Capture order failed:',
                error
            );

            return res
                .status(500)
                .json({
                    success: false,
                    error:
                        error.message ||
                        'Unable to capture PayPal payment.'
                });
        }
    }
);

/* =========================================================
   ORDER TRACKING
   ========================================================= */

app.get(
    '/api/orders/:orderId',
    (req, res) => {
        const requestedId =
            normalizeText(
                req.params.orderId,
                100
            ).toUpperCase();

        const order =
            ordersDatabase.find(
                item =>
                    String(item.id)
                        .toUpperCase() ===
                    requestedId
            );

        if (!order) {
            return res
                .status(404)
                .json({
                    success: false,
                    error:
                        'Order not found.'
                });
        }

        /*
         * Return only the data necessary for
         * customer tracking.
         */
        return res.json({
            success: true,

            id:
                order.id,

            date:
                order.date,

            total:
                order.total,

            status:
                order.status,

            items:
                order.items
        });
    }
);

/* =========================================================
   DISCORD BUTTONS
   ========================================================= */

client.on(
    'interactionCreate',
    async interaction => {
        if (
            !interaction.isButton()
        ) {
            return;
        }

        try {
            const customId =
                interaction.customId;

            const separatorIndex =
                customId.indexOf('_');

            if (
                separatorIndex === -1
            ) {
                return;
            }

            const action =
                customId.substring(
                    0,
                    separatorIndex
                );

            const orderId =
                customId.substring(
                    separatorIndex + 1
                );

            const order =
                ordersDatabase.find(
                    item =>
                        item.id ===
                        orderId
                );

            if (!order) {
                await interaction.reply({
                    content:
                        '⚠️ هذا الطلب غير موجود في قاعدة الطلبات الحالية.',
                    ephemeral: true
                });

                return;
            }

            if (
                action === 'accept'
            ) {
                order.status =
                    'مقبول';

                await interaction.update({
                    content:
                        interaction.message.content.replace(
                            '⏳ قيد الانتظار',
                            `✅ **مقبول** (بواسطة ${interaction.user.tag})`
                        ),

                    components: []
                });

                console.log(
                    `[ORDER] ${order.id} accepted by ${interaction.user.tag}`
                );

                return;
            }

            if (
                action === 'reject'
            ) {
                order.status =
                    'مرفوض';

                await interaction.update({
                    content:
                        interaction.message.content.replace(
                            '⏳ قيد الانتظار',
                            `❌ **مرفوض** (بواسطة ${interaction.user.tag})`
                        ),

                    components: []
                });

                console.log(
                    `[ORDER] ${order.id} rejected by ${interaction.user.tag}`
                );

                return;
            }

        } catch (error) {
            console.error(
                '[DISCORD] Interaction error:',
                error
            );

            if (
                interaction.replied ||
                interaction.deferred
            ) {
                return;
            }

            try {
                await interaction.reply({
                    content:
                        'حدث خطأ أثناء معالجة الطلب.',
                    ephemeral: true
                });
            } catch (_) {
                // Ignore reply failure.
            }
        }
    }
);

/* =========================================================
   DISCORD READY
   ========================================================= */

client.once(
    'ready',
    () => {
        console.log(
            '========================================'
        );

        console.log(
            `[BOT SUCCESS] Logged in as ${client.user.tag}!`
        );

        console.log(
            `[SERVER] Port: ${PORT}`
        );

        console.log(
            `[SERVER] Frontend: ${
                FRONTEND_URL || 'CORS *'
            }`
        );

        console.log(
            `[PAYPAL] Mode: ${PAYPAL_MODE}`
        );

        console.log(
            `[PAYPAL] Configured: ${
                Boolean(
                    PAYPAL_CLIENT_ID &&
                    PAYPAL_CLIENT_SECRET
                )
            }`
        );

        console.log(
            '========================================'
        );
    }
);

/* =========================================================
   START SERVER
   ========================================================= */

app.listen(
    PORT,
    '0.0.0.0',
    () => {
        console.log(
            `[SERVER] Express listening on 0.0.0.0:${PORT}`
        );
    }
);

/* =========================================================
   LOGIN
   ========================================================= */

if (!process.env.DISCORD_TOKEN) {
    console.error(
        '[FATAL] DISCORD_TOKEN is missing.'
    );

    process.exit(1);
}

client.login(
    process.env.DISCORD_TOKEN
);
