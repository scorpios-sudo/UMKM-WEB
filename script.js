require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { OpenAI } = require('openai');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());

// Konfigurasi OpenAI (opsional)
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// Variabel global untuk menyimpan koneksi HP
let connectedDevice = null; // simpan socket

// -----------------------------
// WebSocket: untuk koneksi ke aplikasi Android
// -----------------------------
wss.on('connection', (ws, req) => {
  console.log('📱 HP terhubung via WebSocket');
  connectedDevice = ws;

  ws.on('message', (message) => {
    console.log('📨 Dari HP:', message.toString());
    // Bisa handle pesan balasan dari HP jika diperlukan
  });

  ws.on('close', () => {
    console.log('📱 HP terputus');
    connectedDevice = null;
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    connectedDevice = null;
  });
});

// Fungsi mengirim perintah ke HP (jika terhubung)
function sendCommandToDevice(command) {
  if (connectedDevice && connectedDevice.readyState === WebSocket.OPEN) {
    connectedDevice.send(JSON.stringify(command));
    return true;
  }
  return false;
}

// -----------------------------
// Endpoint untuk cek status
// -----------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/hp-status', (req, res) => {
  res.json({
    connected: connectedDevice !== null && connectedDevice.readyState === WebSocket.OPEN,
  });
});

// -----------------------------
// Fungsi parsing perintah sederhana (fallback jika tanpa OpenAI)
// -----------------------------
function parseCommandSimple(message) {
  const lower = message.toLowerCase();

  // Buka aplikasi: "buka whatsapp" atau "open whatsapp"
  const openMatch = message.match(/(?:buka|open)\s+(\w+)/i);
  if (openMatch) {
    let appName = openMatch[1].toLowerCase();
    // mapping nama aplikasi ke package name (contoh)
    const appMap = {
      wa: 'com.whatsapp',
      whatsapp: 'com.whatsapp',
      ig: 'com.instagram.android',
      instagram: 'com.instagram.android',
      fb: 'com.facebook.katana',
      facebook: 'com.facebook.katana',
      chrome: 'com.android.chrome',
    };
    const pkg = appMap[appName] || appName;
    return { action: 'open_app', params: { package: pkg } };
  }

  // Klik teks: "klik teks Login" atau "click text Login"
  const clickMatch = message.match(/(?:klik|click)\s+teks\s+(.+)/i);
  if (clickMatch) {
    return { action: 'click_text', params: { text: clickMatch[1].trim() } };
  }

  // Ketik teks: "ketik halo" atau "type halo"
  const typeMatch = message.match(/(?:ketik|type)\s+(.+)/i);
  if (typeMatch) {
    return { action: 'type_text', params: { text: typeMatch[1].trim() } };
  }

  // Tap koordinat: "tap 200 300"
  const tapMatch = message.match(/tap\s+(\d+)\s+(\d+)/i);
  if (tapMatch) {
    return { action: 'tap', params: { x: parseInt(tapMatch[1]), y: parseInt(tapMatch[2]) } };
  }

  // Back
  if (/(?:back|kembali)/i.test(message)) {
    return { action: 'back', params: {} };
  }

  // Home
  if (/home/i.test(message)) {
    return { action: 'home', params: {} };
  }

  return null;
}

// -----------------------------
// Fungsi parsing dengan OpenAI (jika ada API key)
// -----------------------------
async function parseCommandWithAI(message) {
  if (!openai) return null;

  try {
    const prompt = `
      Anda adalah asisten yang mengubah perintah pengguna ke format JSON untuk mengontrol HP Android.
      Perintah yang tersedia:
      - open_app: buka aplikasi (parameter: package)
      - click_text: klik teks tertentu (parameter: text)
      - type_text: ketik teks (parameter: text)
      - tap: tap koordinat (parameter: x, y)
      - back: tekan tombol back
      - home: tekan tombol home

      Contoh:
      User: "buka instagram"
      Output: {"action":"open_app","params":{"package":"com.instagram.android"}}
      User: "klik teks login"
      Output: {"action":"click_text","params":{"text":"login"}}
      User: "ketik halo dunia"
      Output: {"action":"type_text","params":{"text":"halo dunia"}}
      User: "tap 100 200"
      Output: {"action":"tap","params":{"x":100,"y":200}}
      User: "back"
      Output: {"action":"back","params":{}}
      User: "home"
      Output: {"action":"home","params":{}}

      Sekarang ubah perintah berikut ke JSON (hanya output JSON, tidak perlu penjelasan):
      "${message}"
    `;

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 150,
      temperature: 0,
    });

    const content = completion.choices[0].message.content.trim();
    // Ambil JSON dari response
    const jsonMatch = content.match(/\{.*\}/s);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (err) {
    console.error('OpenAI parsing error:', err);
    return null;
  }
}

// -----------------------------
// Endpoint utama /chat
// -----------------------------
app.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Pesan kosong' });
  }

  // 1. Parsing perintah dari pesan (pakai OpenAI jika ada, fallback ke rule-based)
  let command = null;
  if (openai) {
    command = await parseCommandWithAI(message);
  }
  if (!command) {
    command = parseCommandSimple(message);
  }

  // 2. Jika command ditemukan dan HP terhubung, kirim perintah
  let commandSent = false;
  if (command) {
    commandSent = sendCommandToDevice(command);
  }

  // 3. Buat balasan ke user
  let reply = '';
  if (command) {
    if (commandSent) {
      reply = `✅ Perintah "${command.action}" berhasil dikirim ke HP.`;
    } else {
      reply = `⚠️ Perintah "${command.action}" dikenali, tapi HP sedang tidak terhubung. Pastikan aplikasi Android aktif dan koneksi WebSocket stabil.`;
    }
  } else {
    // Tidak ada command yang dikenali, bisa pakai OpenAI chat biasa (opsional)
    if (openai) {
      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: message }],
          max_tokens: 300,
        });
        reply = completion.choices[0].message.content;
      } catch (err) {
        console.error('OpenAI chat error:', err);
        reply = 'Maaf, saya tidak mengerti perintah itu. Coba: "buka WhatsApp", "klik teks Login", "ketik halo", "back", "home".';
      }
    } else {
      reply = 'Maaf, saya tidak mengerti perintah itu. Coba: "buka WhatsApp", "klik teks Login", "ketik halo", "back", "home".';
    }
  }

  res.json({ reply });
});

// -----------------------------
// Jalankan server
// -----------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
  console.log(`🔌 WebSocket tersedia di ws://localhost:${PORT}`);
});
