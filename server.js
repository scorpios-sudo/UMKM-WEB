const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

let connectedDevice = null;

wss.on('connection', (ws) => {
  console.log('Device connected');
  connectedDevice = ws;

  ws.on('message', (message) => {
    console.log('Received from device:', message.toString());
  });

  ws.on('close', () => {
    connectedDevice = null;
    console.log('Device disconnected');
  });
});

// Fungsi kirim perintah ke HP
function sendCommandToDevice(command) {
  if (connectedDevice && connectedDevice.readyState === WebSocket.OPEN) {
    connectedDevice.send(JSON.stringify(command));
    return true;
  }
  return false;
}

// Di endpoint /chat, setelah parsing perintah, panggil sendCommandToDevice