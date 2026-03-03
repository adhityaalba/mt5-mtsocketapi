require('dotenv').config();
const net = require('net');

/**
 * SMART SAFE DCA BOT (v2)
 * -----------------------
 * 1. Trend Filter: EMA 200 (Only BUY if Price > EMA 200).
 * 2. DCA System: ATR-based steps with Max Layers protection.
 * 3. Smart Exit: Closes in profit if price breaks below EMA 50 (momentum loss).
 * 4. Safety: Individual SL/TP + Basket protection.
 */

class SmartSafeBot {
    constructor() {
        this.config = {
            host: process.env.MT5_HOST || '127.0.0.1',
            port: parseInt(process.env.MT5_PORT) || 7777,
            symbol: process.env.SYMBOL || 'XAUUSD',
            lot: parseFloat(process.env.LOT_SIZE) || 0.01,
            maxLayers: parseInt(process.env.MAX_LAYERS) || 3,
            orderMode: process.env.ORDER_MODE || 'MARKET',
            
            // Indicators
            emaFast: parseInt(process.env.EMA_FAST_PERIOD) || 50,
            emaSlow: parseInt(process.env.EMA_SLOW_PERIOD) || 200,
            
            // SL & TP (Points)
            slPoints: parseInt(process.env.STOP_LOSS_POINTS) || 1000,
            tpPoints: parseInt(process.env.TAKE_PROFIT_POINTS) || 2000,

            // Trailing Stop (Fallback Safety)
            trailStart: parseInt(process.env.TRAILING_START_POINTS) || 500,
            trailDist: parseInt(process.env.TRAILING_DISTANCE_POINTS) || 700,
            trailStep: parseInt(process.env.TRAILING_STEP_POINTS) || 100,

            // Safety Basket
            tpUsd: parseFloat(process.env.TAKE_PROFIT_USD) || 50.0,
            basketSLPercent: parseFloat(process.env.BASKET_STOP_LOSS_PERCENT) || 15.0,
            atrPeriod: parseInt(process.env.ATR_PERIOD) || 14,
            atrMultiplier: parseFloat(process.env.ATR_MULTIPLIER) || 3.0,
            minStepPoints: parseInt(process.env.MIN_STEP_POINTS) || 500,
            
            magic: 888 
        };

        this.isRunning = false;
    }

    async sendRequest(msg) {
        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            client.setTimeout(10000);

            client.connect(this.config.port, this.config.host, () => {
                client.write(JSON.stringify(msg) + "\r\n");
            });

            client.on('data', (data) => {
                const strData = data.toString();
                try {
                    const response = JSON.parse(strData);
                    resolve(response);
                } catch (e) {
                    reject(new Error("JSON Parse Error: " + strData));
                }
                client.destroy();
            });

            client.on('error', (err) => { client.destroy(); reject(err); });
            client.on('timeout', () => { client.destroy(); reject(new Error("Timeout")); });
        });
    }

    async getMA(period) {
        try {
            const res = await this.sendRequest({
                "MSG": "MA_INDICATOR",
                "SYMBOL": this.config.symbol,
                "TIMEFRAME": "PERIOD_M15",
                "MA_PERIOD": period,
                "MA_SHIFT": 0,
                "MA_METHOD": 1, // MODE_EMA
                "APPLIED_PRICE": 0 // PRICE_CLOSE
            });
            return res.DATA_VALUES ? res.DATA_VALUES[0] : undefined;
        } catch (e) { return undefined; }
    }

    async tick() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            console.log(`\n--- [${new Date().toLocaleTimeString()}] Monitoring Price ---`);

            // 1. Position Sync
            const account = await this.sendRequest({ "MSG": "ACCOUNT_STATUS" });
            const orders = await this.sendRequest({ "MSG": "ORDER_LIST" });
            const myOrders = (orders.OPENED || []).filter(o => 
                o.SYMBOL === this.config.symbol && (o.MAGIC === this.config.magic || o.COMMENT.includes("SafePro"))
            );
            
            const totalPL = myOrders.reduce((sum, o) => sum + (o.PROFIT || 0), 0);
            const currentLayers = myOrders.length;
            
            console.log(`Equity: ${account.EQUITY} | Positions: ${currentLayers} | Floating P/L: ${totalPL.toFixed(2)} USD`);

            // 2. Data Analysis
            const quote = await this.sendRequest({ "MSG": "QUOTE", "SYMBOL": this.config.symbol });
            const price = quote.BID;
            const emaFast = await this.getMA(this.config.emaFast); // Short trend
            const emaSlow = await this.getMA(this.config.emaSlow); // Long trend

            if (price === undefined || emaFast === undefined || emaSlow === undefined) {
                console.log("⚠️ Waiting for Market Data/Indicators...");
                this.isRunning = false;
                return;
            }

            console.log(`Price: ${price} | EMA50: ${emaFast.toFixed(2)} | EMA200: ${emaSlow.toFixed(2)}`);

            // 3. EXIT STRATEGY (Smart Close)
            if (currentLayers > 0) {
                // A. Basket Protection
                const slAmount = (account.BALANCE * (this.config.basketSLPercent / 100)) * -1;
                if (totalPL <= slAmount || totalPL >= this.config.tpUsd) {
                    console.log(`⚠️ Basket TP/SL Goal Met! P/L: ${totalPL.toFixed(2)}. Closing all...`);
                    await this.closeAll(myOrders);
                    this.isRunning = false;
                    return;
                }

                // B. SMART PROFIT LOCK (Exit if Momentum Slows)
                // Jika total profit > $2.00 dan harga menembus ke bawah EMA 50 (Sinyal Lemah)
                if (totalPL >= 2.0 && price < emaFast) {
                    console.log(`📉 SMART CLOSE: Momentum Melemah (Price < EMA50) & Profit Terkunci ($${totalPL.toFixed(2)}). Closing...`);
                    await this.closeAll(myOrders);
                    this.isRunning = false;
                    return;
                }

                // C. Trailing Stop (Individual)
                for (const order of myOrders) {
                    const pointVal = this.config.symbol.includes("XAU") ? 0.01 : 0.00001;
                    const profitPoints = (order.PRICE_CURRENT - order.PRICE_OPEN) * (this.config.symbol.includes("XAU") ? 100 : 100000);

                    if (profitPoints >= this.config.trailStart) {
                        const newSL = parseFloat((order.PRICE_CURRENT - (this.config.trailDist * pointVal)).toFixed(2));
                        const currentSL = order.SL || 0;
                        if (newSL > currentSL + (this.config.trailStep * pointVal)) {
                            console.log(`🛡️ Trailing SL Update Ticket #${order.TICKET} to ${newSL}`);
                            await this.sendRequest({
                                "MSG": "ORDER_MODIFY", "TICKET": order.TICKET, "SL": newSL, "TP": order.TP
                            });
                        }
                    }
                }
            }

            // 4. ENTRY LOGIC (Buy Trend Only)
            if (currentLayers < this.config.maxLayers) {
                const isBullish = price > emaSlow;

                if (currentLayers === 0) {
                    if (isBullish) {
                        console.log("🚀 Sinyal Entry: Price > EMA200. Membuka posisi pertama.");
                        await this.openOrder(price);
                    }
                } else {
                    // DCA Logic
                    const lastOrder = myOrders[myOrders.length - 1];
                    const distPoints = Math.abs(price - lastOrder.PRICE_OPEN) * (this.config.symbol.includes("XAU") ? 100 : 100000);
                    
                    const atrRes = await this.sendRequest({ "MSG": "ATR_INDICATOR", "SYMBOL": this.config.symbol, "TIMEFRAME": "PERIOD_M15", "PERIOD": this.config.atrPeriod });
                    const stepRequired = Math.max(atrRes.VALUE * this.config.atrMultiplier * (this.config.symbol.includes("XAU") ? 100 : 100000), this.config.minStepPoints);

                    if (price < lastOrder.PRICE_OPEN && distPoints >= stepRequired) {
                        console.log(`🛠️ DCA Layer: Dist ${distPoints.toFixed(0)} >= Required ${stepRequired.toFixed(0)}. Adding Layer.`);
                        await this.openOrder(price);
                    }
                }
            }

        } catch (error) {
            console.error("Tick Error:", error.message);
        } finally {
            this.isRunning = false;
        }
    }

    async openOrder(currentPrice) {
        const pointVal = this.config.symbol.includes("XAU") ? 0.01 : 0.00001;
        const slPrice = currentPrice - (this.config.slPoints * pointVal);
        const tpPrice = currentPrice + (this.config.tpPoints * pointVal);

        const cmd = {
            "MSG": "ORDER_SEND",
            "SYMBOL": this.config.symbol,
            "VOLUME": this.config.lot,
            "MAGIC": this.config.magic,
            "COMMENT": "SafePro_v2",
            "SL": parseFloat(slPrice.toFixed(2)),
            "TP": parseFloat(tpPrice.toFixed(2))
        };

        if (this.config.orderMode === 'LIMIT') {
            cmd.TYPE = "ORDER_TYPE_BUY_LIMIT";
            cmd.PRICE = parseFloat((currentPrice - (150 * pointVal)).toFixed(2));
            console.log(`Memasang BUY LIMIT di ${cmd.PRICE}`);
        } else {
            cmd.TYPE = "ORDER_TYPE_BUY";
            console.log(`Melakukan MARKET BUY...`);
        }

        const res = await this.sendRequest(cmd);
        if (res.ERROR_ID === 0) console.log("✅ Order Berhasil.");
        else console.error("❌ Gagal Order:", res.ERROR_DESCRIPTION);
    }

    async closeAll(orders) {
        for (const order of orders) {
            await this.sendRequest({ "MSG": "ORDER_CLOSE", "TICKET": order.TICKET });
        }
        console.log("✅ Semua posisi ditutup.");
    }

    start() {
        console.log("--- SMART SAFE BOT v2 STARTED (RSI REMOVED) ---");
        setInterval(() => this.tick(), 10000);
        this.tick();
    }
}

const bot = new SmartSafeBot();
bot.start();
