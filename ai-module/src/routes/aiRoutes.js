// ============================================================
// CLEANOVA AI MODULE - Routes API phân tích ảnh & báo giá
// ============================================================
const express = require('express');
const multer = require('multer');

const { analyzeImage, buildRecommendations } = require('../analyzer/imageAnalyzer');
const { calculatePrice, resolveDirtLevel } = require('../pricing/priceCalculator');

const router = express.Router();

// --- Cấu hình multer: giữ ảnh trong RAM, giới hạn dung lượng & loại file ---
const maxBytes = parseInt(process.env.MAX_UPLOAD_BYTES, 10) || 10 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxBytes },
  fileFilter(req, file, cb) {
    if (/^image\/(jpeg|png|webp|bmp|gif)$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Chỉ chấp nhận file ảnh (jpeg, png, webp, bmp, gif).'));
    }
  }
});

// Chuyển lỗi multer thành JSON gọn gàng
function handleUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ success: false, message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Thiếu file ảnh (field "image").' });
    }
    next();
  });
}

function buildFileMeta(file) {
  return {
    filename: file.originalname,
    mimetype: file.mimetype,
    size: file.size
  };
}

// ------------------------------------------------------------
// POST /api/ai/analyze
// Body: multipart/form-data, field "image"
// Trả về: điểm bẩn, các chỉ số, phát hiện, khuyến nghị
// ------------------------------------------------------------
router.post('/analyze', handleUpload, async (req, res, next) => {
  try {
    const analysis = await analyzeImage(req.file.buffer, buildFileMeta(req.file));

    const level = resolveDirtLevel(analysis.overallScore);
    const recommendations = buildRecommendations(analysis.signals, level.level);

    res.json({
      success: true,
      data: {
        ...analysis,
        dirtLevel: {
          level: level.level,
          label: level.label,
          priceMultiplier: level.priceMultiplier
        },
        recommendations
      }
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// POST /api/ai/estimate
// Body: multipart/form-data
//   - image           (bắt buộc)
//   - areaSize        (số m2, tuỳ chọn)
//   - urgency         normal|soon|urgent (tuỳ chọn)
//   - extras          "mold,grease" (tuỳ chọn, cách nhau dấu phẩy)
// Trả về: phân tích + báo giá đầy đủ
// ------------------------------------------------------------
router.post('/estimate', handleUpload, async (req, res, next) => {
  try {
    const analysis = await analyzeImage(req.file.buffer, buildFileMeta(req.file));

    const extras = req.body.extras
      ? String(req.body.extras).split(',').map(s => s.trim()).filter(Boolean)
      : [];

    const quote = calculatePrice(analysis, {
      areaSize: req.body.areaSize,
      urgency: req.body.urgency,
      extras
    });

    const recommendations = buildRecommendations(analysis.signals, quote.dirtLevel.level);

    res.json({
      success: true,
      data: {
        analysis: {
          analyzer: analysis.analyzer,
          overallScore: analysis.overallScore,
          signals: analysis.signals,
          findings: analysis.findings,
          features: analysis.features
        },
        dirtLevel: quote.dirtLevel,
        quote,
        recommendations
      }
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------
// GET /api/ai/services - Trả về bảng gói dịch vụ để frontend hiển thị
// ------------------------------------------------------------
router.get('/services', (req, res) => {
  const { SERVICE_PACKAGES, DIRT_LEVELS, SURCHARGES } = require('../config/businessRules');
  res.json({
    success: true,
    data: { services: SERVICE_PACKAGES, dirtLevels: DIRT_LEVELS, surcharges: SURCHARGES }
  });
});

// ------------------------------------------------------------
// GET /api/ai/health
// ------------------------------------------------------------
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'Cleanova AI Module',
    analyzer: (process.env.ANALYZER || 'builtin'),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
