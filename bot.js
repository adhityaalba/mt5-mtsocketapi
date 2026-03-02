require('dotenv').config();
const net = require('net');

/**
 * STRUKTUR BOT TRADING DCA (SAFE MODE)
 * -----------------------------------
 * 1. Basket Stop Loss: Proteksi modal total.
 * 2. Max Layer: Membatasi penggunaan margin.
 * 3. Lot Flat: Menghindari overload margin.
 * 4. ATR-based Step: Jarak antar posisi mengikuti volatilitas pasar.
 */

class SafeDCABot {
    constructor() {
        this.config = {
            host: process.env.MT5_HOST || '127.0.0.1',
            port: parseInt(process.env.MT5_PORT) || 7777,
            symbol: process.env.SYMBOL || 'XAUUSD',
            lot: parseFloat(process.env.LOT_SIZE) || 0.01,
            maxLayers: parseInt(process.env.MAX_LAYERS) || 5,
            side: process.env.SIDE || 'BUY',
            tpUsd: parseFloat(process.env.TAKE_PROFIT_USD) || 5.0,
            basketSLPercent: parseFloat(process.env.BASKET_STOP_LOSS_PERCENT) || 15.0,
            atrPeriod: parseInt(process.env.ATR_PERIOD) || 14,
            atrMultiplier: parseFloat(process.env.ATR_MULTIPLIER) || 2.0,
            minStepPoints: parseInt(process.env.MIN_STEP_POINTS) || 200
        };

        this.isRunning = false;
        this.client = null;
    }

    // --- KONEKSI KE MT5 ---
    async sendRequest(msg) {
        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            client.setTimeout(5000);

            client.connect(this.config.port, this.config.host, () => {
                client.write(JSON.stringify(msg) + "\r\n");
            });

            client.on('data', (data) => {
                try {
                    const response = JSON.parse(data.toString());
                    resolve(response);
                } catch (e) {
                    reject(new Error("Gagal parse JSON dari MT5"));
                }
                client.destroy();
            });

            client.on('error', (err) => {
                client.destroy();
                reject(err);
            });

            client.on('timeout', () => {
                client.destroy();
                reject(new Error("Timeout komunikasi dengan MT5"));
            });
        });
    }

    // --- LOGIKA UTAMA ---
    async tick() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            console.log(`\n--- [${new Date().toLocaleTimeString()}] Checking Market ---`);

            // 1. Ambil Status Akun
            const account = await this.sendRequest({ "MSG": "ACCOUNT_STATUS" });
            const balance = account.BALANCE;
            const equity = account.EQUITY;
            const marginLevel = account.MARGIN_LEVEL;
            
            // 2. Ambil Posisi Terbuka (Filter berdasarkan Symbol)
            const orders = await this.sendRequest({ "MSG": "ORDER_LIST" });
            const myOrders = (orders.ORDERS || []).filter(o => o.SYMBOL === this.config.symbol);
            
            // Hitung Profit/Loss Berjalan dari posisi kita
            const totalPL = myOrders.reduce((sum, o) => sum + o.PROFIT, 0);
            const currentLayers = myOrders.length;
            
            console.log(`Balance: ${balance} | Equity: ${equity} | Margin Level: ${marginLevel}%`);
            console.log(`Posisi Terbuka (${this.config.symbol}): ${currentLayers} | Total P/L: ${totalPL.toFixed(2)} USD`);

            // 3. CEK PROTECTION (Basket Stop Loss & Take Profit)
            const slAmount = (balance * (this.config.basketSLPercent / 100)) * -1;
            
            if (currentLayers > 0) {
                // Skenario A: Rugi mencapai batas % Modal
                if (totalPL <= slAmount) {
                    console.log(`⚠️ BASKET STOP LOSS TERPICU! (Loss: ${totalPL} <= Limit: ${slAmount})`);
                    await this.closeAll(myOrders);
                    this.isRunning = false;
                    return;
                }

                // Skenario B: Untung mencapai target USD
                if (totalPL >= this.config.tpUsd) {
                    console.log(`💰 TAKE PROFIT TERPICU! (Profit: ${totalPL} >= Target: ${this.config.tpUsd})`);
                    await this.closeAll(myOrders);
                    this.isRunning = false;
                    return;
                }
            }

            // 4. CEK ORDER BARU (DCA ENTRY)
            if (currentLayers === 0) {
                // Belum ada order, buka order pertama
                console.log(`Membuka order pertama: ${this.config.side} ${this.config.lot} lot`);
                await this.openOrder();
            } else if (currentLayers < this.config.maxLayers) {
                // Cek apakah sudah waktunya tambah layer (DCA)
                await this.checkNewLayer(myOrders);
            } else {
                console.log("Max layers tercapai. Menunggu harga balik atau kena Basket SL.");
            }

        } catch (error) {
            console.error("Gagal menjalankan tick:", error.message);
        } finally {
            this.isRunning = false;
        }
    }

    async openOrder() {
        const cmd = {
            "MSG": "ORDER_SEND",
            "SYMBOL": this.config.symbol,
            "TYPE": this.config.side === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',
            "VOLUME": this.config.lot,
            "COMMENT": "SafeDCABot_v1"
        };
        const res = await this.sendRequest(cmd);
        if (res.ERROR_ID === 0) console.log("✅ Order berhasil dibuka.");
        else console.error("❌ Gagal buka order:", res.ERROR_DESCRIPTION);
    }

    async checkNewLayer(myOrders) {
        // Ambil harga saat ini
        const quote = await this.sendRequest({ "MSG": "QUOTE", "SYMBOL": this.config.symbol });
        const currentPrice = this.config.side === 'BUY' ? quote.BID : quote.ASK;
        
        // Ambil harga order terakhir
        // Kita cari order yang harganya paling jauh (sesuai arah DCA)
        const lastOrder = myOrders[myOrders.length - 1];
        const lastEntryPrice = lastOrder.PRICE_OPEN;

        // Hitung Jarak Aman menggunakan ATR (Average True Range)
        const atrRes = await this.sendRequest({ 
            "MSG": "ATR_INDICATOR", 
            "SYMBOL": this.config.symbol, 
            "TIMEFRAME": "PERIOD_M1", 
            "PERIOD": this.config.atrPeriod 
        });
        
        // Jarak Step = ATR * Multiplier, tapi minimal sekian Points/Pips
        let stepPoints = (atrRes.VALUE * this.config.atrMultiplier) * 100000; // Konversi ke points (untuk Gold biasanya 2 digit belakang)
        if (this.config.symbol.includes("XAU")) stepPoints = (atrRes.VALUE * this.config.atrMultiplier) * 100; // Adjusment xau
        
        const finalStep = Math.max(stepPoints, this.config.minStepPoints);
        
        // Hitung selisih harga saat ini dengan harga terakhir
        const priceDiff = Math.abs(currentPrice - lastEntryPrice);
        const diffInPoints = priceDiff * (this.config.symbol.includes("XAU") ? 100 : 100000);

        console.log(`Last Entry: ${lastEntryPrice} | Current: ${currentPrice} | Dist: ${diffInPoints.toFixed(0)} pts | Required Step: ${finalStep.toFixed(0)} pts`);

        // Jika harga bergerak melawan kita (Loss) melebihi step, baru buka layer baru
        const isLossMove = this.config.side === 'BUY' ? (currentPrice < lastEntryPrice) : (currentPrice > lastEntryPrice);

        if (isLossMove && diffInPoints >= finalStep) {
            console.log("Menambah layer DCA baru...");
            await this.openOrder();
        }
    }

    async closeAll(orders) {
        console.log(`Sedang menutup ${orders.length} posisi...`);
        for (const order of orders) {
            await this.sendRequest({
                "MSG": "ORDER_CLOSE",
                "TICKET": order.TICKET
            });
        }
        console.log("✅ Semua posisi ditutup.");
    }

    start() {
        console.log("--- SAFE DCA BOT STARTING ---");
        console.log(`Symbol: ${this.config.symbol} | Strategy: ${this.config.side} DCA`);
        console.log(`Safety: Basket SL ${this.config.basketSLPercent}% | Max Layers: ${this.config.maxLayers}`);
        
        // Tick setiap 5 detik
        setInterval(() => this.tick(), 5000);
        this.tick();
    }
}

const bot = new SafeDCABot();
bot.start();
