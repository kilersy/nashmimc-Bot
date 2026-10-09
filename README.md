# NashmiMC Store Bot

Backend for NashmiMC Minecraft Store.

## Features

- Discord bot with order notifications
- PayPal payment integration (automatic capture verification)
- USDT TRC20 manual payment with proof images
- Auto-generated PNG invoice images for PayPal orders
- PostgreSQL persistence
- Rate limiting + strict input validation
- Anti-XSS sanitization for Discord messages

## Environment Variables

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Discord bot token |
| `ADMIN_CHANNEL_ID` | Discord channel ID for incoming orders |
| `PAYPAL_CLIENT_ID` | PayPal application client ID |
| `PAYPAL_CLIENT_SECRET` | PayPal application secret |
| `PAYPAL_MODE` | `live` or `sandbox` |
| `FRONTEND_URL` | Storefront URL used for CORS |
| `DATABASE_URL` | PostgreSQL connection string |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Service status check |
| GET | `/api/stats` | Order statistics (admin) |
| GET | `/api/orders/:id` | Track a single order |
| POST | `/api/new-order` | Create crypto (USDT) order |
| POST | `/api/paypal/create-order` | Initialize PayPal order |
| POST | `/api/paypal/capture-order` | Finalize PayPal payment |

## How It Works

1. Customer picks items on the storefront.
2. **PayPal:** Order captured server-side, verified, and an auto-generated PNG invoice is sent to Discord.
3. **USDT:** Customer uploads a payment proof image, which is forwarded to Discord along with the order details.
4. Admin approves/rejects directly from Discord buttons.
5. Order status syncs back to the storefront tracking page.

## Requirements

- Node.js >= 18
- PostgreSQL database
- Discord bot with `Guilds` intent

## Deployment

Deployed on [Render](https://render.com). The storefront is on [Vercel](https://vercel.com).
