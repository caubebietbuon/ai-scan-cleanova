// ============================================================
// CLEANOVA AI MODULE - Express App
// ============================================================
const express = require('express');
const cors = require('cors');
const path = require('path');

const aiRoutes = require('./routes/aiRoutes');

const app = express();

// Cho phép gọi từ mọi origin trong môi trường dev (frontend Cleanova ở cổng 5000,
// Live Server 5500, hoặc mở trực tiếp từ module này ở cổng 5100).
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- API ---
app.use('/api/ai', aiRoutes);

// Trang kiểm tra nhanh
app.get('/', (req, res) => {
  res.json({
    service: 'Cleanova AI Module',
    version: '1.0.0',
    endpoints: {
      health: 'GET  /api/ai/health',
      services: 'GET  /api/ai/services',
      analyze: 'POST /api/ai/analyze   (multipart: image)',
      estimate: 'POST /api/ai/estimate  (multipart: image, areaSize, urgency, extras)'
    },
    demo: '/index.html'
  });
});

// --- Giao diện demo tĩnh (thư mục public/) ---
// Phục vụ cả ở gốc (http://host:5100) và dưới /demo để tiện truy cập.
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));
app.use('/demo', express.static(publicPath));

// 404 cho API
app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint không tồn tại.' });
});

// Xử lý lỗi tập trung
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[AI Module Error]', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Lỗi máy chủ AI.'
  });
});

module.exports = app;
