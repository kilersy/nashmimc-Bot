/* =========================================================
   NashmiMC Store — Frontend Script (Manual Payment)
   ========================================================= */

'use strict';

let cart = [];
let selectedPaymentMethod = 'paypal';
let discountPercent = 0;
let appliedCouponName = '';

const API_URL = (() => {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
        return 'http://localhost:3000';
    }
    return 'https://nashmimc-bot.onrender.com';
})();

const STORAGE_KEY = 'nashmi_orders';
const MAX_HISTORY = 50;
const MAX_PROOF_MB = 3;

/* =========================================================
   PRODUCT CATALOG
   ========================================================= */
const PRODUCTS = [
    { id: 'vip_rank',      category: 'rank', title: 'VIP Rank',      price: 3.99,  image: 'vip.jpg',     nameClass: 'rank-vip',       infoTitle: 'VIP Rank Features',       infoText: 'Grants basic VIP prefix, /feed command, 3 homes limit, and access to VIP kit.' },
    { id: 'mvp_rank',      category: 'rank', title: 'MVP Rank',      price: 9.99,  image: 'mvp.jpg',     nameClass: 'rank-mvp',       infoTitle: 'MVP Rank Features',       infoText: 'Grants MVP prefix, /heal, /feed, 5 homes limit, 2 virtual vaults, and MVP kit.' },
    { id: 'mvp_plus_rank', category: 'rank', title: 'MVP+ Rank',     price: 17.99, image: 'mvp+.jpg',    nameClass: 'rank-mvpplus',   infoTitle: 'MVP+ Rank Features',      infoText: 'Grants MVP+ prefix, /fly in lobby, /heal, /feed, 8 homes limit, 4 virtual vaults, and exclusive kit.' },
    { id: 'nashmi_rank',   category: 'rank', title: 'NASHMI Rank',   price: 29.99, image: 'nashmi.png',  nameClass: 'rank-nashmi',    infoTitle: 'NASHMI Rank Features',    infoText: 'Grants custom NASHMI prefix, /fly, /workbench, /anvil, 12 homes, 6 virtual vaults, and elite kit.' },
    { id: 'nashmi_plus',   category: 'rank', title: 'NASHMI+ Rank',  price: 59.99, image: 'nashmi+.png', nameClass: 'rank-nashmiplus', infoTitle: 'NASHMI+ Rank Features',  infoText: 'Grants ultimate NASHMI+ prefix, all commands unlocked, /fly, /heal, /feed, /anvil, /ec, 20 homes, 10 virtual vaults, and legendary kit.' },

    { id: 'smp_money_100k', category: 'smp_money', title: '100k SMP Money', price: 0.99,  image: 'money.jpg', nameClass: 'item-money' },
    { id: 'smp_money_300k', category: 'smp_money', title: '300k SMP Money', price: 2.49,  image: 'money.jpg', nameClass: 'item-money' },
    { id: 'smp_money_500k', category: 'smp_money', title: '500k SMP Money', price: 4.99,  image: 'money.jpg', nameClass: 'item-money' },
    { id: 'smp_money_1m',   category: 'smp_money', title: '1M SMP Money',   price: 9.99,  image: 'money.jpg', nameClass: 'item-money' },
    { id: 'smp_money_3m',   category: 'smp_money', title: '3M SMP Money',   price: 24.99, image: 'money.jpg', nameClass: 'item-money' },
    { id: 'smp_money_5m',   category: 'smp_money', title: '5M SMP Money',   price: 49.99, image: 'money.jpg', nameClass: 'item-money' },
    { id: 'smp_money_10m',  category: 'smp_money', title: '10M SMP Money',  price: 74.99, image: 'money.jpg', nameClass: 'item-money' },

    { id: 'smp_gold_100',   category: 'smp_gold', title: '100 SMP Gold',     price: 0.99,  image: 'gold.jpg', nameClass: 'item-gold' },
    { id: 'smp_gold_720',   category: 'smp_gold', title: '720 SMP Gold',     price: 4.99,  image: 'gold.jpg', nameClass: 'item-gold' },
    { id: 'smp_gold_1680',  category: 'smp_gold', title: '1680 SMP Gold',    price: 9.99,  image: 'gold.jpg', nameClass: 'item-gold' },
    { id: 'smp_gold_3600',  category: 'smp_gold', title: '3600 SMP Gold',    price: 19.99, image: 'gold.jpg', nameClass: 'item-gold' },
    { id: 'smp_gold_6580',  category: 'smp_gold', title: '6580 SMP Gold',    price: 34.99, image: 'gold.jpg', nameClass: 'item-gold' },
    { id: 'smp_gold_10k',   category: 'smp_gold', title: '10,000 SMP Gold',  price: 49.99, image: 'gold.jpg', nameClass: 'item-gold' },
    { id: 'smp_gold_16600', category: 'smp_gold', title: '16,600 SMP Gold',  price: 74.99, image: 'gold.jpg', nameClass: 'item-gold' },
    { id: 'smp_gold_22400', category: 'smp_gold', title: '22,400 SMP Gold',  price: 99.99, image: 'gold.jpg', nameClass: 'item-gold' },

    { id: 'smp_key_doom',   category: 'smp_key', title: 'DOOM key',   price: 2.49, image: 'doom_key.jpg',   nameClass: 'key-doom',   hasQty: true },
    { id: 'smp_key_magma',  category: 'smp_key', title: 'MAGMA Key',  price: 4.99, image: 'magma_Key.jpg',  nameClass: 'key-magma',  hasQty: true },
    { id: 'smp_key_mythic', category: 'smp_key', title: 'MYTHIC Key', price: 9.99, image: 'mythic_key.jpg', nameClass: 'key-mythic', hasQty: true },

    { id: 'box_gold_100',   category: 'box_gold', title: '100 Box Gold',     price: 0.99,  image: 'gold.jpg', nameClass: 'item-gold' },
    { id: 'box_gold_720',   category: 'box_gold', title: '720 Box Gold',     price: 4.99,  image: 'gold.jpg', nameClass: 'item-gold' },
    { id: 'box_gold_1680',  category: 'box_gold', title: '1680 Box Gold',    price: 9.99,  image: 'gold.jpg', nameClass: 'item-gold' },
    { id: 'box_gold_3600',  category: 'box_gold', title: '3600 Box Gold',    price: 19.99, image: 'gold.jpg', nameClass: 'item-gold' },
    { id: 'box_gold_6580',  category: 'box_gold', title: '6580 Box Gold',    price: 34.99, image: 'gold.jpg', nameClass: 'item-gold' },
    { id: 'box_gold_10k',   category: 'box_gold', title: '10,000 Box Gold',  price: 49.99, image: 'gold.jpg', nameClass: 'item-gold' },
    { id: 'box_gold_16400', category: 'box_gold', title: '16,400 Box Gold',  price: 74.99, image: 'gold.jpg', nameClass: 'item-gold' },
    { id: 'box_gold_22400', category: 'box_gold', title: '22,400 Box Gold',  price: 99.99, image: 'gold.jpg', nameClass: 'item-gold' },

    { id: 'box_key_mecha', category: 'box_key', title: 'Mecha Key', price: 5.00, image: 'Mecha.png', nameClass: 'key-mecha', hasQty: true }
];

/* =========================================================
   INIT
   ========================================================= */
document.addEventListener('DOMContentLoaded', () => {
    renderAllProducts();
    initNavigation();
    initDrawers();
    initCartActions();
    initCustomBuilder();
    initCheckoutActions();
    initTrackingActions();
    initCopyButtons();
    initEscapeAndOverlay();
    initPaymentTabs();
    initSubmitButton();
    renderUserOrders();

    setInterval(syncOrdersFromServer, 60000);
});

/* =========================================================
   PRODUCTS
   ========================================================= */
function renderAllProducts() {
    document.querySelectorAll('.products-grid[data-category]').forEach(grid => {
        const category = grid.dataset.category;
        const items = PRODUCTS.filter(p => p.category === category);
        grid.innerHTML = '';
        items.forEach(product => {
            grid.appendChild(buildProductCard(product));
        });
    });
}

function buildProductCard(product) {
    const card = document.createElement('div');
    card.className = 'product-card';

    const frame = document.createElement('div');
    frame.className = 'product-image-frame';
    const img = document.createElement('img');
    img.src = product.image;
    img.alt = product.title;
    img.loading = 'lazy';
    frame.appendChild(img);

    const info = document.createElement('div');
    const nameRow = document.createElement('div');
    nameRow.className = 'product-name-row';

    const nameEl = document.createElement('div');
    nameEl.className = 'product-name ' + (product.nameClass || '');
    nameEl.textContent = product.title;
    nameRow.appendChild(nameEl);

    if (product.infoTitle && product.infoText) {
        const infoBtn = document.createElement('span');
        infoBtn.className = 'rank-info-btn';
        infoBtn.textContent = '?';
        infoBtn.title = 'Rank Info';
        infoBtn.addEventListener('click', () => {
            showNotification(
                '<i class="fa-solid fa-crown accent-icon"></i>',
                product.infoTitle,
                product.infoText
            );
        });
        nameRow.appendChild(infoBtn);
    }

    info.appendChild(nameRow);

    const priceEl = document.createElement('div');
    priceEl.className = 'product-price';
    priceEl.textContent = '$' + product.price.toFixed(2);
    info.appendChild(priceEl);

    let getQty = () => 1;

    if (product.hasQty) {
        const qtyRow = document.createElement('div');
        qtyRow.className = 'qty-row';

        const qtyLabel = document.createElement('label');
        qtyLabel.className = 'qty-label';
        qtyLabel.textContent = 'Quantity:';

        const qtyInput = document.createElement('input');
        qtyInput.type = 'number';
        qtyInput.className = 'qty-input-box';
        qtyInput.min = '1';
        qtyInput.value = '1';

        qtyInput.addEventListener('input', () => {
            const q = Math.max(1, parseInt(qtyInput.value) || 1);
            priceEl.textContent = '$' + (product.price * q).toFixed(2);
        });

        qtyRow.appendChild(qtyLabel);
        qtyRow.appendChild(qtyInput);
        info.appendChild(qtyRow);

        getQty = () => Math.max(1, parseInt(qtyInput.value) || 1);
    }

    card.appendChild(frame);
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'card-actions-row';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn-cart-action';
    addBtn.textContent = 'Add to Cart';
    addBtn.addEventListener('click', () => addProductToCart(product, getQty()));

    const buyBtn = document.createElement('button');
    buyBtn.type = 'button';
    buyBtn.className = 'btn-buynow-action';
    buyBtn.textContent = 'Buy Now';
    buyBtn.addEventListener('click', () => {
        addProductToCart(product, getQty());
        openCheckoutModal();
    });

    actions.appendChild(addBtn);
    actions.appendChild(buyBtn);
    card.appendChild(actions);

    return card;
}

function addProductToCart(product, qty) {
    const safeQty = Math.max(1, parseInt(qty) || 1);
    const title = safeQty > 1 ? `${safeQty}x ${product.title}` : product.title;
    const totalPrice = Number((product.price * safeQty).toFixed(2));

    cart.push({ title, price: totalPrice });
    updateCartUI();

    showNotification(
        '<i class="fa-solid fa-cart-plus"></i>',
        'Added to Cart',
        `${escapeHtml(title)} has been added to your cart.`
    );
}

/* =========================================================
   NAVIGATION
   ========================================================= */
function initNavigation() {
    document.querySelectorAll('.nav-item[data-section]').forEach(item => {
        item.addEventListener('click', () => switchSection(item.dataset.section));
    });

    document.querySelectorAll('.drawer-links a[data-section]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            switchSection(link.dataset.section);
            closeDrawer(document.getElementById('sideDrawer'));
        });
    });

    document.querySelectorAll('.dropdown-item[data-section]').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            switchSection(item.dataset.section);
            closeAllDropdowns();
        });
    });

    initDropdowns();
}

function initDropdowns() {
    const smpBtn = document.getElementById('smpNavBtn');
    const smpDropdown = document.getElementById('smpDropdown');
    const boxBtn = document.getElementById('boxNavBtn');
    const boxDropdown = document.getElementById('boxDropdown');

    if (smpBtn && smpDropdown) {
        smpBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (boxDropdown) boxDropdown.classList.remove('show');
            smpDropdown.classList.toggle('show');
        });
    }

    if (boxBtn && boxDropdown) {
        boxBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (smpDropdown) smpDropdown.classList.remove('show');
            boxDropdown.classList.toggle('show');
        });
    }

    document.addEventListener('click', closeAllDropdowns);
}

function closeAllDropdowns() {
    document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
}

function switchSection(sectionId) {
    document.querySelectorAll('.store-section').forEach(sec => sec.classList.remove('active'));
    const target = document.getElementById(sectionId);
    if (target) {
        target.classList.add('active');
        window.scrollTo({ top: 300, behavior: 'smooth' });
    }
}

/* =========================================================
   DRAWERS
   ========================================================= */
function initDrawers() {
    document.getElementById('cartToggleBtn')?.addEventListener('click', () => {
        document.getElementById('cartDrawer')?.classList.toggle('active');
    });
    document.getElementById('cartCloseBtn')?.addEventListener('click', () => {
        document.getElementById('cartDrawer')?.classList.remove('active');
    });
    document.getElementById('navToggleBtn')?.addEventListener('click', () => {
        document.getElementById('sideDrawer')?.classList.toggle('active');
    });
    document.getElementById('navCloseBtn')?.addEventListener('click', () => {
        document.getElementById('sideDrawer')?.classList.remove('active');
    });
}

function closeDrawer(el) {
    if (el) el.classList.remove('active');
}

/* =========================================================
   CART
   ========================================================= */
function initCartActions() {
    document.getElementById('clearCartBtn')?.addEventListener('click', clearCart);
    document.getElementById('couponApplyBtn')?.addEventListener('click', applyCoupon);
    document.getElementById('checkoutBtn')?.addEventListener('click', openCheckoutModal);
}

function clearCart() {
    if (cart.length === 0) {
        showNotification('<i class="fa-solid fa-circle-exclamation"></i>', 'Empty Cart', 'Your cart is already empty.');
        return;
    }

    showConfirmNotification(
        '<i class="fa-solid fa-trash"></i>',
        'Clear Cart?',
        'This will remove all items from your cart. The coupon will remain applied.',
        () => {
            cart = [];
            updateCartUI();
            showNotification('<i class="fa-solid fa-check"></i>', 'Cart Cleared', 'All items have been removed.');
        }
    );
}

function updateCartUI() {
    const container = document.getElementById('cartItemsContainer');
    const countEl = document.getElementById('cart-count');
    const totalEl = document.getElementById('cartTotalDisplay');
    if (!container || !countEl || !totalEl) return;

    container.innerHTML = '';
    countEl.textContent = String(cart.length);

    let subtotal = 0;

    cart.forEach((item, index) => {
        const itemPrice = Number(item.price) || 0;
        subtotal += itemPrice;

        const itemCard = document.createElement('div');
        itemCard.className = 'cart-item-card';

        const info = document.createElement('div');
        info.className = 'cart-item-info';

        const titleEl = document.createElement('span');
        titleEl.className = 'cart-item-title';
        titleEl.textContent = item.title;

        const priceEl = document.createElement('span');
        priceEl.className = 'cart-item-price';
        priceEl.textContent = '$' + itemPrice.toFixed(2);

        info.appendChild(titleEl);
        info.appendChild(priceEl);

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'cart-item-remove';
        removeBtn.setAttribute('aria-label', 'Remove item');
        removeBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        removeBtn.addEventListener('click', () => removeFromCart(index));

        itemCard.appendChild(info);
        itemCard.appendChild(removeBtn);
        container.appendChild(itemCard);
    });

    const finalTotal = subtotal * (1 - discountPercent / 100);
    totalEl.textContent = '$' + finalTotal.toFixed(2);
}

function removeFromCart(index) {
    if (index < 0 || index >= cart.length) return;
    cart.splice(index, 1);
    updateCartUI();
}

function applyCoupon() {
    const codeInput = document.getElementById('couponCodeInput');
    const msg = document.getElementById('couponMsg');
    if (!codeInput || !msg) return;

    const code = (codeInput.value || '').trim().toUpperCase();

    if (code === 'NASHMI2026') {
        discountPercent = 15;
        appliedCouponName = code;
        msg.style.color = 'var(--success)';
        msg.textContent = 'Coupon NASHMI2026 applied! (15% OFF)';
    } else {
        discountPercent = 0;
        appliedCouponName = '';
        msg.style.color = 'var(--danger)';
        msg.textContent = 'Invalid Coupon Code!';
    }

    updateCartUI();
}

/* =========================================================
   CHECKOUT MODAL
   ========================================================= */
function initCheckoutActions() {
    document.getElementById('checkoutCloseBtn')?.addEventListener('click', closeCheckoutModal);
}

function openCheckoutModal() {
    if (cart.length === 0) {
        showNotification('<i class="fa-solid fa-circle-exclamation"></i>', 'Empty Cart', 'Your shopping cart is empty.');
        return;
    }

    const modal = document.getElementById('checkoutModal');
    if (modal) modal.classList.add('open');

    setPaymentMethod(selectedPaymentMethod);
}

function closeCheckoutModal() {
    const modal = document.getElementById('checkoutModal');
    if (modal) modal.classList.remove('open');
}

/* =========================================================
   PAYMENT TABS
   ========================================================= */
function initPaymentTabs() {
    document.getElementById('tabPaypal')?.addEventListener('click', () => setPaymentMethod('paypal'));
    document.getElementById('tabCrypto')?.addEventListener('click', () => setPaymentMethod('crypto'));
}

function setPaymentMethod(method) {
    selectedPaymentMethod = method === 'crypto' ? 'crypto' : 'paypal';

    const tabPaypal = document.getElementById('tabPaypal');
    const tabCrypto = document.getElementById('tabCrypto');
    const paypalContainer = document.getElementById('paypalContainer');
    const cryptoDetails = document.getElementById('cryptoDetails');
    const proofContainer = document.getElementById('proofUploadContainer');

    if (tabPaypal) tabPaypal.classList.toggle('active', selectedPaymentMethod === 'paypal');
    if (tabCrypto) tabCrypto.classList.toggle('active', selectedPaymentMethod === 'crypto');
    
    if (paypalContainer) paypalContainer.style.display = selectedPaymentMethod === 'paypal' ? 'block' : 'none';
    if (cryptoDetails) cryptoDetails.style.display = selectedPaymentMethod === 'crypto' ? 'block' : 'none';

    // تعديل: رفع الصورة بيظهر دايماً (سواء باي بال أو كريبتو)
    if (proofContainer) {
        proofContainer.style.display = 'block'; 
    }
}

/* =========================================================
   SUBMIT (Manual Payment)
   ========================================================= */
function initSubmitButton() {
    document.getElementById('submitBtn')?.addEventListener('click', () => processCheckoutWebhook('Manual Payment'));
}

async function processCheckoutWebhook(paymentReference) {
    if (cart.length === 0) {
        showNotification('<i class="fa-solid fa-circle-exclamation"></i>', 'Empty Cart', 'Your shopping cart is empty.');
        return;
    }

    const customer = getCheckoutCustomer();
    if (!customer) return;

    let imageProof = null;
    try {
        imageProof = await readPaymentProof();
    } catch (error) {
        showNotification('<i class="fa-solid fa-triangle-exclamation"></i>', 'Payment Proof Error', error.message);
        return;
    }

    if (!imageProof) {
        showNotification('<i class="fa-solid fa-image"></i>', 'Payment Proof Required', 'Please attach your payment proof image before submitting.');
        return;
    }

    const orderId = makeClientOrderId();
    const finalTotal = getCartFinalTotal().toFixed(2);

    const orderData = {
        orderId,
        ign: customer.ign,
        discordUser: customer.discordUser,
        paymentMethod: selectedPaymentMethod.toUpperCase(),
        paymentReference,
        items: getServerCart(),
        imageProof
    };

    try {
        setCheckoutBusy(true, 'Submitting Order');

        const result = await apiRequest('/api/new-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderData)
        });

        if (!result || result.success !== true) {
            throw new Error(result?.error || 'Server rejected the order.');
        }

        const serverOrderId = result.orderId || orderId;
        const serverTotal = Number(result.total ?? finalTotal).toFixed(2);

        finalizeOrderSuccess(serverOrderId, serverTotal);
    } catch (error) {
        showNotification('<i class="fa-solid fa-circle-exclamation"></i>', 'Order Failed', error.message || 'The order could not be sent to the store server.');
    } finally {
        setCheckoutBusy(false, 'Complete Payment & Submit Order');
    }
}

/* =========================================================
   HELPERS
   ========================================================= */
function getCheckoutCustomer() {
    const ignInput = document.getElementById('checkoutIgnInput');
    const discordInput = document.getElementById('checkoutDiscordInput');
    const ign = (ignInput?.value || '').trim();
    const discordUser = (discordInput?.value || '').trim();

    if (!ign) {
        showNotification('<i class="fa-solid fa-triangle-exclamation"></i>', 'Minecraft Name Required', 'Please enter your Minecraft IGN.');
        ignInput?.focus();
        return null;
    }

    if (!/^[A-Za-z0-9_]{1,16}$/.test(ign)) {
        showNotification('<i class="fa-solid fa-triangle-exclamation"></i>', 'Invalid IGN', 'IGN must be 1-16 chars (letters, numbers, underscore only).');
        ignInput?.focus();
        return null;
    }

    if (!discordUser) {
        showNotification('<i class="fa-solid fa-triangle-exclamation"></i>', 'Discord Username Required', 'Please enter your Discord username.');
        discordInput?.focus();
        return null;
    }

    if (!/^[a-zA-Z0-9._]{2,32}(#\d{4})?$/.test(discordUser)) {
        showNotification('<i class="fa-solid fa-triangle-exclamation"></i>', 'Invalid Discord Username', 'Use 2-32 chars (letters, numbers, dot, underscore).');
        discordInput?.focus();
        return null;
    }

    return { ign, discordUser };
}

function getCartFinalTotal() {
    const subtotal = cart.reduce((sum, item) => {
        const price = Number(item.price);
        return sum + (Number.isFinite(price) ? price : 0);
    }, 0);
    return Number((subtotal * (1 - discountPercent / 100)).toFixed(2));
}

function getServerCart() {
    return cart.map(item => ({
        title: String(item.title || '').trim(),
        price: Number(Number(item.price || 0).toFixed(2)),
        ...(item.details ? { details: String(item.details) } : {})
    }));
}

function readPaymentProof() {
    return new Promise((resolve, reject) => {
        const proofInput = document.getElementById('checkoutProofImage');
        const imageFile = proofInput?.files?.[0] || null;

        if (!imageFile) {
            resolve(null);
            return;
        }

        const maxSizeBytes = MAX_PROOF_MB * 1024 * 1024;
        if (imageFile.size > maxSizeBytes) {
            reject(new Error(`Image too large. Max ${MAX_PROOF_MB} MB.`));
            return;
        }

        if (!/^image\/(png|jpeg|jpg|webp)$/i.test(imageFile.type)) {
            reject(new Error('Please upload a PNG, JPG, or WEBP image.'));
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                try {
                    const MAX_DIM = 1600;
                    let w = img.width;
                    let h = img.height;

                    if (w > MAX_DIM || h > MAX_DIM) {
                        if (w > h) {
                            h = Math.round(h * (MAX_DIM / w));
                            w = MAX_DIM;
                        } else {
                            w = Math.round(w * (MAX_DIM / h));
                            h = MAX_DIM;
                        }
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);

                    const compressed = canvas.toDataURL('image/jpeg', 0.8);
                    resolve(compressed);
                } catch (err) {
                    resolve(e.target.result);
                }
            };
            img.onerror = () => resolve(e.target.result);
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('Unable to read the image.'));
        reader.readAsDataURL(imageFile);
    });
}

function makeClientOrderId() {
    const timestamp = Date.now().toString(36).toUpperCase();
    const randomPart = Math.floor(1000 + Math.random() * 9000);
    return `NASHMI-${timestamp}-${randomPart}`;
}

function setCheckoutBusy(isBusy, text = 'Complete Payment & Submit Order') {
    const submitBtn = document.getElementById('submitBtn');
    if (!submitBtn) return;
    submitBtn.disabled = isBusy;
    submitBtn.innerHTML = isBusy
        ? '<i class="fa-solid fa-spinner fa-spin"></i> Processing...'
        : `${text} <i class="fa-solid fa-paper-plane"></i>`;
}

/* =========================================================
   API
   ========================================================= */
async function apiRequest(path, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await fetch(`${API_URL}${path}`, {
            ...options,
            headers: {
                Accept: 'application/json',
                ...(options.headers || {})
            },
            mode: 'cors',
            signal: controller.signal
        });

        const contentType = response.headers.get('content-type') || '';
        let data;

        if (contentType.includes('application/json')) {
            data = await response.json();
        } else {
            const text = await response.text();
            data = text ? { message: text } : {};
        }

        if (!response.ok) {
            throw new Error(data?.error || data?.message || `Server returned HTTP ${response.status}`);
        }

        return data;
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error('The store server took too long to respond. Please try again.');
        }
        if (error instanceof TypeError) {
            throw new Error('Could not connect to the store server. Check your connection.');
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

/* =========================================================
   ORDER SUCCESS
   ========================================================= */
function finalizeOrderSuccess(orderId, finalTotal) {
    saveOrderToHistory({
        id: orderId,
        date: new Date().toLocaleDateString(),
        total: finalTotal,
        status: 'pending',
        items: [...cart]
    });

    closeCheckoutModal();
    resetCart();

    showOrderSuccessNotification(
        orderId,
        'Your order has been sent to Discord.<br>Execution time inside the server is within <strong>3 to 4 hours maximum</strong>.'
    );

    switchSection('tracking-section');
}

function resetCart() {
    cart = [];
    discountPercent = 0;
    appliedCouponName = '';

    const couponInput = document.getElementById('couponCodeInput');
    const msg = document.getElementById('couponMsg');
    const fileInput = document.getElementById('checkoutProofImage');
    if (couponInput) couponInput.value = '';
    if (msg) msg.textContent = '';
    if (fileInput) fileInput.value = '';

    updateCartUI();
}

function showOrderSuccessNotification(orderId, message) {
    const icon = document.getElementById('notifIcon');
    const titleEl = document.getElementById('notifTitle');
    const msg = document.getElementById('notifMsg');
    const modal = document.getElementById('notificationModal');
    const actions = document.getElementById('notifActions');

    if (icon) icon.innerHTML = '<i class="fa-solid fa-circle-check success-icon"></i>';
    if (titleEl) titleEl.textContent = 'Order Submitted Successfully!';

    if (msg) {
        msg.innerHTML = '';
        const strong = document.createElement('strong');
        strong.className = 'order-id-display';
        strong.textContent = orderId;
        msg.appendChild(document.createTextNode('Your Order ID: '));
        msg.appendChild(strong);
        msg.appendChild(document.createElement('br'));
        msg.appendChild(document.createElement('br'));
        msg.insertAdjacentHTML('beforeend', message);
    }

    if (actions) {
        actions.innerHTML = '';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn-modal-ok';
        copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy Order ID';
        copyBtn.addEventListener('click', () => copyOrderId(orderId));

        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'btn-modal-ok';
        okBtn.textContent = 'OK';
        okBtn.addEventListener('click', closeNotificationModal);

        actions.appendChild(copyBtn);
        actions.appendChild(okBtn);
    }

    if (modal) modal.classList.add('open');
}

function copyOrderId(orderId) {
    navigator.clipboard.writeText(orderId).then(() => {
        showNotification('<i class="fa-solid fa-copy"></i>', 'Copied', 'Order ID copied to clipboard!');
    });
}

/* =========================================================
   ORDER HISTORY
   ========================================================= */
function saveOrderToHistory(order) {
    let history = [];
    try {
        history = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch { history = []; }

    history.unshift(order);
    history = history.slice(0, MAX_HISTORY);

    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    renderUserOrders();
}

function normalizeStatus(status) {
    if (!status) return 'pending';
    const s = String(status).toLowerCase().trim();
    if (s === 'approved' || s === 'مقبول') return 'approved';
    if (s === 'rejected' || s === 'مرفوض') return 'rejected';
    if (s === 'unknown') return 'unknown';
    return 'pending';
}

function renderUserOrders() {
    const container = document.getElementById('userOrdersContainer');
    if (!container) return;

    let history = [];
    try {
        history = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch { history = []; }

    container.innerHTML = '';

    if (history.length === 0) {
        const p = document.createElement('p');
        p.className = 'no-orders-msg';
        p.textContent = 'No active orders found on this device.';
        container.appendChild(p);
        return;
    }

    history.forEach(ord => {
        const itemEl = document.createElement('div');
        itemEl.className = 'order-history-item';

        const left = document.createElement('div');

        const idEl = document.createElement('strong');
        idEl.className = 'order-history-id';
        idEl.textContent = ord.id;

        const meta = document.createElement('div');
        meta.className = 'order-history-meta';
        meta.textContent = `Date: ${ord.date || 'N/A'} | Total: $${ord.total ?? '0.00'}`;

        left.appendChild(idEl);
        left.appendChild(meta);

        const badge = document.createElement('span');
        const ns = normalizeStatus(ord.status);
        let statusClass = 'status-pending';
        let statusIcon = 'fa-clock';
        let statusText = 'Pending';

        if (ns === 'approved') {
            statusClass = 'status-success';
            statusIcon = 'fa-check';
            statusText = 'Approved';
        } else if (ns === 'rejected') {
            statusClass = 'status-danger';
            statusIcon = 'fa-xmark';
            statusText = 'Rejected';
        } else if (ns === 'unknown') {
            statusClass = 'status-danger';
            statusIcon = 'fa-question';
            statusText = 'Not Found';
        }

        badge.className = `status-badge ${statusClass}`;
        badge.innerHTML = `<i class="fa-solid ${statusIcon}"></i> ${statusText}`;

        itemEl.appendChild(left);
        itemEl.appendChild(badge);
        container.appendChild(itemEl);
    });
}

async function syncOrdersFromServer() {
    let history = [];
    try {
        history = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch { return; }

    if (history.length === 0) return;

    let updated = false;
    const toRemove = [];

    await Promise.all(history.map(async localOrd => {
        try {
            const srvOrd = await apiRequest(`/api/orders/${encodeURIComponent(localOrd.id)}`);

            if (!srvOrd || !srvOrd.status) return;

            const normalized = normalizeStatus(srvOrd.status);

            if (normalized !== localOrd.status) {
                localOrd.status = normalized;
                updated = true;
            }

            if (srvOrd.total != null) {
                const srvTotal = Number(srvOrd.total).toFixed(2);
                if (String(localOrd.total) !== srvTotal) {
                    localOrd.total = srvTotal;
                    updated = true;
                }
            }
        } catch (err) {
            const msg = String(err && err.message || '').toLowerCase();
            if (msg.includes('not found')) {
                toRemove.push(localOrd.id);
            }
        }
    }));

    if (toRemove.length > 0) {
        history = history.filter(o => !toRemove.includes(o.id));
        updated = true;
    }

    if (updated) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
        renderUserOrders();
    }
}

/* =========================================================
   TRACKING
   ========================================================= */
function initTrackingActions() {
    document.getElementById('trackBtn')?.addEventListener('click', trackOrder);
    const input = document.getElementById('trackingInput');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') trackOrder();
        });
    }
}

async function trackOrder() {
    const input = document.getElementById('trackingInput');
    const resultBox = document.getElementById('trackingResultBox');
    const resultText = document.getElementById('trackingResultText');
    const value = (input?.value || '').trim();

    if (!value) {
        showNotification('<i class="fa-solid fa-triangle-exclamation"></i>', 'Track Order', 'Please enter a valid Order ID.');
        return;
    }

    if (resultBox) resultBox.style.display = 'block';
    if (resultText) resultText.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';

    try {
        const found = await apiRequest(`/api/orders/${encodeURIComponent(value)}`);
        if (!found || !found.id) throw new Error('Order not found.');

        const items = Array.isArray(found.items) ? found.items : [];

        if (resultText) {
            resultText.innerHTML = '';

            const appendLine = (label, val) => {
                const strong = document.createElement('strong');
                strong.textContent = label + ': ';
                resultText.appendChild(strong);
                resultText.appendChild(document.createTextNode(String(val)));
                resultText.appendChild(document.createElement('br'));
            };

            appendLine('Order ID', found.id);
            appendLine('Date', found.date || 'N/A');
            appendLine('Total', '$' + Number(found.total || 0).toFixed(2));

            const stStrong = document.createElement('strong');
            stStrong.textContent = 'Status: ';
            resultText.appendChild(stStrong);

            const ns = normalizeStatus(found.status);
            let statusLabel = 'Pending';
            if (ns === 'approved') statusLabel = 'Approved';
            else if (ns === 'rejected') statusLabel = 'Rejected';

            const badge = document.createElement('span');
            badge.className = 'status-badge';
            badge.innerHTML = `<i class="fa-solid fa-info-circle"></i> ${escapeHtml(statusLabel)}`;
            resultText.appendChild(badge);
            resultText.appendChild(document.createElement('br'));
            resultText.appendChild(document.createElement('br'));

            const itemsStrong = document.createElement('strong');
            itemsStrong.textContent = 'Items Included:';
            resultText.appendChild(itemsStrong);
            resultText.appendChild(document.createElement('br'));

            if (items.length === 0) {
                resultText.appendChild(document.createTextNode('No item details.'));
            } else {
                items.forEach(item => {
                    const line = document.createElement('div');
                    line.textContent = `• ${item.title || ''} ($${Number(item.price || 0).toFixed(2)})`;
                    resultText.appendChild(line);
                });
            }
        }

        let history = [];
        try { history = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { history = []; }

        const existingIndex = history.findIndex(o => String(o.id).toUpperCase() === String(found.id).toUpperCase());

        const compact = {
            id: found.id,
            date: found.date || new Date().toLocaleDateString(),
            total: Number(found.total || 0).toFixed(2),
            status: normalizeStatus(found.status),
            items
        };

        if (existingIndex >= 0) history[existingIndex] = compact;
        else history.unshift(compact);

        history = history.slice(0, MAX_HISTORY);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
        renderUserOrders();
    } catch (error) {
        if (resultText) {
            resultText.innerHTML = '';
            const strong = document.createElement('strong');
            strong.textContent = 'Order ID: ';
            resultText.appendChild(strong);
            resultText.appendChild(document.createTextNode(value));
            resultText.appendChild(document.createElement('br'));
            const st = document.createElement('strong');
            st.textContent = 'Status: ';
            resultText.appendChild(st);
            resultText.appendChild(document.createTextNode('Not Found'));
        }
    }
}

/* =========================================================
   COPY BUTTONS
   ========================================================= */
function initCopyButtons() {
    document.querySelectorAll('[data-copy]').forEach(btn => {
        btn.addEventListener('click', () => {
            const value = btn.dataset.copy || '';
            const label = btn.dataset.copyLabel || 'Value';
            navigator.clipboard.writeText(value).then(() => {
                showNotification(
                    '<i class="fa-solid fa-copy"></i>',
                    label + ' Copied',
                    label + ' copied to clipboard!'
                );
            });
        });
    });
}

/* =========================================================
   NOTIFICATION MODAL
   ========================================================= */
function showNotification(iconHtml, title, message) {
    const icon = document.getElementById('notifIcon');
    const titleEl = document.getElementById('notifTitle');
    const msg = document.getElementById('notifMsg');
    const modal = document.getElementById('notificationModal');
    const actions = document.getElementById('notifActions');

    if (icon) icon.innerHTML = iconHtml;
    if (titleEl) titleEl.textContent = title;
    if (msg) msg.textContent = message;

    if (actions) {
        actions.innerHTML = '';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'btn-modal-ok';
        okBtn.textContent = 'OK';
        okBtn.addEventListener('click', closeNotificationModal);
        actions.appendChild(okBtn);
    }

    if (modal) modal.classList.add('open');
}

function showConfirmNotification(iconHtml, title, message, onConfirm) {
    const icon = document.getElementById('notifIcon');
    const titleEl = document.getElementById('notifTitle');
    const msg = document.getElementById('notifMsg');
    const modal = document.getElementById('notificationModal');
    const actions = document.getElementById('notifActions');

    if (icon) icon.innerHTML = iconHtml;
    if (titleEl) titleEl.textContent = title;
    if (msg) msg.textContent = message;

    if (actions) {
        actions.innerHTML = '';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-clear-cart';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', closeNotificationModal);

        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'btn-modal-ok';
        okBtn.textContent = 'Confirm';
        okBtn.addEventListener('click', () => {
            closeNotificationModal();
            onConfirm();
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(okBtn);
    }

    if (modal) modal.classList.add('open');
}

function closeNotificationModal() {
    const modal = document.getElementById('notificationModal');
    if (modal) modal.classList.remove('open');
}

/* =========================================================
   ESCAPE + OVERLAY CLICK
   ========================================================= */
function initEscapeAndOverlay() {
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;

        closeNotificationModal();
        closeCheckoutModal();

        document.getElementById('cartDrawer')?.classList.remove('active');
        document.getElementById('sideDrawer')?.classList.remove('active');
        closeAllDropdowns();
    });

    ['checkoutModal', 'notificationModal'].forEach(id => {
        const overlay = document.getElementById(id);
        if (!overlay) return;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.classList.remove('open');
            }
        });
    });
}

/* =========================================================
   CUSTOM RANK BUILDER
   ========================================================= */
function initCustomBuilder() {
    const ids = ['customName', 'customPv', 'customHomes', 'customEc', 'chkAnvil', 'chkTags', 'chkSafeRoom', 'chkColor', 'primaryRankColor', 'secondaryRankColor'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', () => { updateCustomPreview(); calcCustomPrice(); });
            el.addEventListener('change', () => { updateCustomPreview(); calcCustomPrice(); });
        }
    });

    document.querySelectorAll('input[name="colorType"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const isGradient = radio.value === 'gradient' && radio.checked;
            const secGroup = document.getElementById('secondaryColorGroup');
            if (secGroup) secGroup.style.display = isGradient ? 'block' : 'none';
            updateCustomPreview();
        });
    });

    const chkColor = document.getElementById('chkColor');
    if (chkColor) {
        chkColor.addEventListener('change', () => {
            const container = document.getElementById('colorOptionsContainer');
            if (container) container.style.display = chkColor.checked ? 'block' : 'none';
        });
    }

    document.getElementById('customAddBtn')?.addEventListener('click', () => addCustomToCart(false));
    document.getElementById('customBuyBtn')?.addEventListener('click', () => addCustomToCart(true));

    updateCustomPreview();
    calcCustomPrice();
}

function updateCustomPreview() {
    const nameInput = document.getElementById('customName');
    const previewEl = document.getElementById('liveRankPreview');
    const colorHex = document.getElementById('colorHexCodeDisplay');
    const chkColor = document.getElementById('chkColor');

    if (!previewEl) return;

    const name = ((nameInput?.value || '').trim().toUpperCase() || 'KING').replace(/[^A-Z0-9_]/g, '').substring(0, 16);

    if (!chkColor?.checked) {
        previewEl.style.background = 'none';
        previewEl.style.color = '#fbbf24';
        previewEl.style.webkitBackgroundClip = 'initial';
        previewEl.style.webkitTextFillColor = 'initial';
        previewEl.textContent = `[${name}]`;
        if (colorHex) colorHex.textContent = 'Color Styling: Default (#fbbf24)';
        return;
    }

    const isGradient = document.querySelector('input[name="colorType"]:checked')?.value === 'gradient';
    const pColor = document.getElementById('primaryRankColor')?.value || '#ffffff';
    const sColor = document.getElementById('secondaryRankColor')?.value || '#ffffff';

    if (isGradient) {
        previewEl.style.background = `linear-gradient(90deg, ${pColor}, ${sColor})`;
        previewEl.style.webkitBackgroundClip = 'text';
        previewEl.style.webkitTextFillColor = 'transparent';
        previewEl.textContent = `[${name}]`;
        if (colorHex) colorHex.textContent = `Gradient HEX: ${pColor} > ${sColor}`;
    } else {
        previewEl.style.background = 'none';
        previewEl.style.color = pColor;
        previewEl.style.webkitBackgroundClip = 'initial';
        previewEl.style.webkitTextFillColor = 'initial';
        previewEl.textContent = `[${name}]`;
        if (colorHex) colorHex.textContent = `Solid HEX Code: ${pColor}`;
    }
}

function calcCustomPrice() {
    let price = 5.00;

    const pv = Math.min(10, Math.max(0, parseInt(document.getElementById('customPv')?.value) || 0));
    const homes = Math.min(7, Math.max(2, parseInt(document.getElementById('customHomes')?.value) || 2));
    const ecPrice = parseFloat(document.getElementById('customEc')?.value) || 0;

    price += pv * 3.00;
    if (homes > 2) price += (homes - 2) * 1.50;
    price += ecPrice;

    if (document.getElementById('chkAnvil')?.checked) price += 3.00;
    if (document.getElementById('chkTags')?.checked) price += 4.00;
    if (document.getElementById('chkSafeRoom')?.checked) price += 5.00;
    if (document.getElementById('chkColor')?.checked) price += 3.00;

    const display = document.getElementById('customPriceDisplay');
    if (display) display.textContent = `$${price.toFixed(2)}`;

    return Number(price.toFixed(2));
}

function getCustomRankDetails() {
    const nameInput = document.getElementById('customName');
    const rawName = ((nameInput?.value || '').trim().toUpperCase() || 'KING').replace(/[^A-Z0-9_]/g, '').substring(0, 16);

    const pv = Math.min(10, Math.max(0, parseInt(document.getElementById('customPv')?.value) || 0));
    const homes = Math.min(7, Math.max(2, parseInt(document.getElementById('customHomes')?.value) || 2));

    const ecSelect = document.getElementById('customEc');
    const ecText = ecSelect ? ecSelect.options[ecSelect.selectedIndex].text : 'None';

    const anvil = document.getElementById('chkAnvil')?.checked ? 'Yes' : 'No';
    const tags = document.getElementById('chkTags')?.checked ? 'Yes' : 'No';
    const safeRoom = document.getElementById('chkSafeRoom')?.checked ? 'Yes' : 'No';
    const hasColor = document.getElementById('chkColor')?.checked;

    let colorInfo = 'Default Accent Color';

    if (hasColor) {
        const isGradient = document.querySelector('input[name="colorType"]:checked')?.value === 'gradient';
        const pColor = document.getElementById('primaryRankColor')?.value || '#ffffff';
        const sColor = document.getElementById('secondaryRankColor')?.value || '#ffffff';

        if (isGradient) colorInfo = `Gradient (${pColor} to ${sColor})`;
        else colorInfo = `Solid (${pColor})`;
    }

    return {
        name: rawName,
        details: `Rank Name: [${rawName}] | Color: ${colorInfo} | PVs: ${pv} | Homes: ${homes} | EC: ${ecText} | Anvil: ${anvil} | Tags: ${tags} | SafeRoom: ${safeRoom}`
    };
}

function addCustomToCart(goToCheckout) {
    const rankObj = getCustomRankDetails();
    const price = calcCustomPrice();

    if (!rankObj.name || rankObj.name.length < 1) {
        showNotification('<i class="fa-solid fa-triangle-exclamation"></i>', 'Rank Name Required', 'Please enter a custom rank name.');
        return;
    }

    cart.push({
        title: `Custom Rank: [${rankObj.name}]`,
        price,
        details: rankObj.details
    });

    updateCartUI();

    if (goToCheckout) openCheckoutModal();
    else showNotification('<i class="fa-solid fa-cart-plus"></i>', 'Custom Rank Added', 'Your custom rank has been added to the cart.');
}

/* =========================================================
   ESCAPE HTML
   ========================================================= */
function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}
