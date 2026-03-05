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
            martingaleMultiplier: parseFloat(process.env.MARTINGALE_MULTIPLIER) || 2.0,
            
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
            limitOffset: parseInt(process.env.LIMIT_OFFSET_POINTS) || 150, // Jarak antrean order limit
            
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
                const firstOrder = myOrders[0];
                const isBuyGroup = firstOrder.TYPE.includes("BUY");

                // A. Basket Protection
                const slAmount = (account.BALANCE * (this.config.basketSLPercent / 100)) * -1;
                if (totalPL <= slAmount || totalPL >= this.config.tpUsd) {
                    console.log(`⚠️ Basket TP/SL Goal Met! P/L: ${totalPL.toFixed(2)}. Closing all...`);
                    await this.closeAll(myOrders);
                    this.isRunning = false;
                    return;
                }

                // B. SMART PROFIT LOCK (Exit if Momentum Slows)
                const momentumLost = (isBuyGroup && price < emaFast) || (!isBuyGroup && price > emaFast);
                if (totalPL >= 2.0 && momentumLost) {
                    console.log(`📉 SMART CLOSE: Momentum Melemah (${isBuyGroup ? 'BUY' : 'SELL'}) & Profit Terkunci ($${totalPL.toFixed(2)}). Closing...`);
                    await this.closeAll(myOrders);
                    this.isRunning = false;
                    return;
                }

                // C. Trailing Stop (Individual)
                for (const order of myOrders) {
                    const pointVal = this.config.symbol.includes("XAU") ? 0.01 : 0.00001;
                    const isOrderBuy = order.TYPE.includes("BUY");
                    const profitPoints = isOrderBuy ? 
                        (order.PRICE_CURRENT - order.PRICE_OPEN) * (this.config.symbol.includes("XAU") ? 100 : 100000) :
                        (order.PRICE_OPEN - order.PRICE_CURRENT) * (this.config.symbol.includes("XAU") ? 100 : 100000);

                    if (profitPoints >= this.config.trailStart) {
                        const trailPoint = this.config.trailDist * pointVal;
                        const newSL = isOrderBuy ? 
                            parseFloat((order.PRICE_CURRENT - trailPoint).toFixed(2)) :
                            parseFloat((order.PRICE_CURRENT + trailPoint).toFixed(2));
                        
                        const currentSL = order.SL || 0;
                        const stepVal = this.config.trailStep * pointVal;
                        
                        // Buy: Update jika SL naik. Sell: Update jika SL turun.
                        const shouldUpdate = isOrderBuy ? (newSL > currentSL + stepVal) : (currentSL === 0 || newSL < currentSL - stepVal);

                        if (shouldUpdate) {
                            console.log(`🛡️ Trailing SL Update Ticket #${order.TICKET} to ${newSL}`);
                            await this.sendRequest({
                                "MSG": "ORDER_MODIFY", "TICKET": order.TICKET, "SL": newSL, "TP": order.TP
                            });
                        }
                    }
                }
            }

            // 4. LOGIKA ENTRY
            const isBullish = price > emaSlow; // Harga > EMA 200
            const isBearish = price < emaSlow; // Harga < EMA 200

            if (currentLayers === 0) {
                // Entry Pertama berdasarkan Tren
                if (isBullish) {
                    console.log("🚀 Sinyal BUY: Price > EMA200 (Tren Up). Membuka posisi BUY.");
                    await this.openOrder(price, this.config.lot, "BUY");
                } else if (isBearish) {
                    console.log("🚀 Sinyal SELL: Price < EMA200 (Tren Down). Membuka posisi SELL.");
                    await this.openOrder(price, this.config.lot, "SELL");
                }
            } else {
                // Logika DCA Martingale (Melanjutkan posisi yang sudah ada)
                const firstOrder = myOrders[0];
                const isBuyGroup = firstOrder.TYPE.includes("BUY");
                const lastOrder = myOrders[myOrders.length - 1];
                const distPoints = Math.abs(price - lastOrder.PRICE_OPEN) * (this.config.symbol.includes("XAU") ? 100 : 100000);
                
                const atrRes = await this.sendRequest({ "MSG": "ATR_INDICATOR", "SYMBOL": this.config.symbol, "TIMEFRAME": "PERIOD_M15", "PERIOD": this.config.atrPeriod });
                const stepRequired = Math.max(atrRes.VALUE * this.config.atrMultiplier * (this.config.symbol.includes("XAU") ? 100 : 100000), this.config.minStepPoints);

                if (currentLayers < this.config.maxLayers && distPoints >= stepRequired) {
                    const nextLot = parseFloat((lastOrder.VOLUME * this.config.martingaleMultiplier).toFixed(2));
                    
                    if (isBuyGroup && price < lastOrder.PRICE_OPEN) {
                        console.log(`🛠️ DCA BUY: Harga turun, tambah Layer BUY ke-${currentLayers+1} (Lot: ${nextLot})`);
                        await this.openOrder(price, nextLot, "BUY");
                    } else if (!isBuyGroup && price > lastOrder.PRICE_OPEN) {
                        console.log(`🛠️ DCA SELL: Harga naik, tambah Layer SELL ke-${currentLayers+1} (Lot: ${nextLot})`);
                        await this.openOrder(price, nextLot, "SELL");
                    }
                }
            }

        } catch (error) {
            console.error("Tick Error:", error.message);
        } finally {
            this.isRunning = false;
        }
    }

    async openOrder(currentPrice, volume, side) {
        const pointVal = this.config.symbol.includes("XAU") ? 0.01 : 0.00001;
        
        let slPrice, tpPrice, type;
        
        if (side === "BUY") {
            slPrice = currentPrice - (this.config.slPoints * pointVal);
            tpPrice = currentPrice + (this.config.tpPoints * pointVal);
            type = this.config.orderMode === 'LIMIT' ? "ORDER_TYPE_BUY_LIMIT" : "ORDER_TYPE_BUY";
        } else {
            slPrice = currentPrice + (this.config.slPoints * pointVal);
            tpPrice = currentPrice - (this.config.tpPoints * pointVal);
            type = this.config.orderMode === 'LIMIT' ? "ORDER_TYPE_SELL_LIMIT" : "ORDER_TYPE_SELL";
        }

        const cmd = {
            "MSG": "ORDER_SEND",
            "SYMBOL": this.config.symbol,
            "VOLUME": volume,
            "TYPE": type,
            "PRICE": currentPrice, // Selalu kirim harga saat ini sebagai referensi
            "MAGIC": this.config.magic,
            "COMMENT": "SafePro_v2",
            "SL": parseFloat(slPrice.toFixed(2)),
            "TP": parseFloat(tpPrice.toFixed(2))
        };

        if (this.config.orderMode === 'LIMIT') {
            const offset = this.config.limitOffset * pointVal;
            cmd.PRICE = side === "BUY" ? parseFloat((currentPrice - offset).toFixed(2)) : parseFloat((currentPrice + offset).toFixed(2));
            console.log(`🛡️ Memasang ${side} LIMIT di ${cmd.PRICE} (Offset: ${this.config.limitOffset} points)`);
        } else {
            console.log(`🚀 Melakukan MARKET ${side}...`);
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
