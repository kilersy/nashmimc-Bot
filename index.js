const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');

const app = express();

// زيادة حد حجم البيانات لدعم الصور والطلبات المتعددة دون رفض
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// تفعيل السماح بالاتصال من المتصفح (CORS)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// استضافة ملفات المتجر الثابتة مباشرة عبر الخادم
app.use(express.static(__dirname));

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ]
});

// معرف قناة الإدارة في ديسكورد
const ADMIN_CHANNEL_ID = '1551626123585130546';

// قاعدة بيانات مؤقتة لتخزين الطلبات
let ordersDatabase = [];

client.once('ready', () => {
    console.log(`========================================`);
    console.log(`[BOT SUCCESS] Logged in as ${client.user.tag}!`);
    console.log(`[STORE URL] http://localhost:3000`);
    console.log(`========================================`);
});

// استقبال الطلب الجديد وإرساله لديسكورد
app.post('/api/new-order', async (req, res) => {
    console.log('----------------------------------------');
    console.log('>>> [API HIT] Received a new order request from website!');
    try {
        const { orderId, ign, discordUser, paymentMethod, total, items, date, imageProof } = req.body;
        console.log(`> Order ID: ${orderId} | IGN: ${ign} | Total: $${total}`);
        
        const newOrder = {
            id: orderId,
            ign,
            discordUser,
            paymentMethod,
            total,
            items,
            date,
            status: 'قيد الانتظار'
        };
        ordersDatabase.unshift(newOrder);

        console.log(`> Fetching Discord admin channel ID: ${ADMIN_CHANNEL_ID}...`);
        const channel = await client.channels.fetch(ADMIN_CHANNEL_ID);
        if (!channel) {
            console.error('❌ [ERROR] Admin channel not found! Check bot permissions and channel ID.');
            return res.status(404).json({ error: 'Admin channel not found' });
        }

        // إرسال صورة إثبات الدفع إن وجدت
        if (imageProof && typeof imageProof === 'string' && imageProof.includes('base64')) {
            try {
                console.log('> Sending payment proof image to Discord...');
                const base64Data = imageProof.split(';base64,').pop();
                const buffer = Buffer.from(base64Data, 'base64');
                await channel.send({
                    files: [{
                        attachment: buffer,
                        name: 'payment_proof.png'
                    }]
                });
                console.log('✅ Image sent successfully.');
            } catch (imgError) {
                console.error('⚠️ [WARNING] Failed to send image proof:', imgError.message);
            }
        } else {
            console.log('> No image proof provided or invalid format.');
        }

        let itemsListStr = items.map(i => `• ${i.title} - $${i.price.toFixed(2)}${i.details ? `\n  [تفاصيل: ${i.details}]` : ''}`).join('\n');

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`accept_${orderId}`)
                    .setLabel('✅ قبول')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`reject_${orderId}`)
                    .setLabel('❌ رفض')
                    .setStyle(ButtonStyle.Danger),
            );

        console.log('> Sending order text details and action buttons to Discord...');
        await channel.send({
            content: `🛒 **طلب شراء جديد من متجر نشمي!**\n` +
                     `- **رقم الطلب:** #${orderId}\n` +
                     `- **اسم اللاعب (IGN):** ${ign}\n` +
                     `- **حساب ديسكورد:** ${discordUser}\n` +
                     `- **طريقة الدفع:** ${paymentMethod}\n` +
                     `- **المجموع:** $${total}\n` +
                     `- **الحالة:** ⏳ قيد الانتظار\n\n` +
                     `**المنتجات:**\n${itemsListStr}`,
            components: [row]
        });
        console.log('✅ [SUCCESS] Order details successfully posted to Discord!');

        res.status(200).json({ success: true, message: 'Order sent to Discord successfully!' });
    } catch (error) {
        console.error('❌ [CRITICAL ERROR] Failed to process order in /api/new-order:', error);
        res.status(500).json({ error: 'Server error: ' + error.message });
    }
});

// إرجاع قائمة الطلبات للموقع
app.get('/api/orders', (req, res) => {
    res.json(ordersDatabase);
});

// التعامل مع أزرار قبول/رفض
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const [action, orderId] = interaction.customId.split('_');
    const order = ordersDatabase.find(o => o.id === orderId);

    if (action === 'accept') {
        if (order) order.status = 'مقبول';
        await interaction.update({ 
            content: interaction.message.content.replace('⏳ قيد الانتظار', '✅ **مقبول** (بواسطة ' + interaction.user.tag + ')'), 
            components: [] 
        });
    } else if (action === 'reject') {
        if (order) order.status = 'مرفوض';
        await interaction.update({ 
            content: interaction.message.content.replace('⏳ قيد الانتظار', '❌ **مرفوض** (بواسطة ' + interaction.user.tag + ')'), 
            components: [] 
        });
    }
});

app.listen(3000, () => {
    console.log('Server is actively listening on port 3000');
});

client.login(process.env.DISCORD_TOKEN);