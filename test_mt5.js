const net = require('net');

const HOST = '127.0.0.1';
const PORT = 7777;

const client = new net.Socket();

// Atur timeout agar tidak menunggu selamanya
client.setTimeout(5000);

console.log(`Mencoba menghubungkan ke MTsocketAPI di ${HOST}:${PORT}...`);

client.connect(PORT, HOST, () => {
    console.log('✅ Terhubung!');
    
    // Gunakan \r\n jika \n saja tidak mempan
    const msg = { "MSG": "HELP" };
    const command = JSON.stringify(msg) + "\r\n";
    
    console.log('Mengirim perintah:', JSON.stringify(msg));
    client.write(command);
});

client.on('data', (data) => {
    console.log('\n📥 RESPON DARI MT5:');
    console.log(data.toString());
    client.destroy(); // Tutup setelah dapet data
});

client.on('timeout', () => {
    console.log('\n⌛ Timeout: MT5 tidak merespon dalam 5 detik.');
    client.destroy();
});

client.on('close', () => {
    console.log('❌ Koneksi ditutup.');
});

client.on('error', (err) => {
    console.error('⚠️ Error:', err.message);
});
