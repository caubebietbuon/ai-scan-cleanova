// ============================================================
// CLEANOVA AI MODULE - Server Entry Point
// ============================================================
const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = require('./src/app');

const PORT = process.env.PORT || 5100;
const HOST = process.env.HOST || '0.0.0.0';

function getLanAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) addresses.push(iface.address);
    }
  }
  return addresses;
}

app.listen(PORT, HOST, () => {
  const lan = getLanAddresses();
  console.log('====================================================');
  console.log('  CLEANOVA AI MODULE IS RUNNING');
  console.log(`  - Local URL:  http://localhost:${PORT}`);
  console.log(`  - Health:     http://localhost:${PORT}/api/ai/health`);
  console.log(`  - Demo UI:    http://localhost:${PORT}/demo/index.html`);
  console.log(`  - Analyzer:   ${process.env.ANALYZER || 'builtin'}`);
  console.log('----------------------------------------------------');
  console.log('  Truy cập từ máy khác trong cùng WiFi/LAN:');
  if (lan.length) lan.forEach(ip => console.log(`  - http://${ip}:${PORT}`));
  else console.log('  - (Không tìm thấy địa chỉ IPv4 LAN.)');
  console.log('====================================================');
});
