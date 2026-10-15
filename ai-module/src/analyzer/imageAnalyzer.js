// ============================================================
// CLEANOVA AI MODULE - Bộ máy phân tích ảnh phòng (Built-in Analyzer)
// ============================================================
// Đây là analyzer "built-in": không cần GPU / API key, chạy thuần Node.js.
//
// Cách hoạt động:
// 1. Trích "dấu vân tay" (fingerprint) từ dữ liệu ảnh: kích thước file,
//    mật độ nén, entropy byte, phân bố sáng/tối, tỉ lệ vùng tối/cạnh.
// 2. Từ các tín hiệu thô đó suy ra 5 chỉ số bẩn (0-100) theo trọng số.
// 3. Tổng hợp thành điểm bẩn tổng (0-100) và mức độ tương ứng.
//
// LƯU Ý: Đây là mô hình heuristic (thống kê đặc trưng ảnh), KHÔNG phải
// mạng nơ-ron. Nó đủ để demo luồng nghiệp vụ và cho kết quả ổn định.
// Khi nhóm có model thật (TensorFlow/PyTorch/API), chỉ cần thay hàm
// `analyzeBuffer` hoặc bật ANALYZER=external trong `.env`.
// ============================================================

const { SIGNAL_WEIGHTS } = require('../config/businessRules');
const { analyzeWithExternalService } = require('./externalAnalyzer');

// --- Ma thuật nhỏ: băm chuỗi thành số trong [0,1) để tạo kết quả ổn định ---
// Cùng một ảnh -> cùng fingerprint -> cùng điểm (không nhảy số mỗi lần gọi).
function stableHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Chuyển sang [0,1)
  return ((h >>> 0) % 100000) / 100000;
}

// Kẹp giá trị vào khoảng [min,max]
function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

// Làm tròn 1 chữ số thập phân
function round1(n) {
  return Math.round(n * 10) / 10;
}

// ------------------------------------------------------------
// Trích đặc trưng thô từ buffer ảnh
// ------------------------------------------------------------
function extractFeatures(buffer, meta = {}) {
  const size = buffer.length;

  // 1) Phân bố byte: đếm tần suất để tính entropy & độ sáng trung bình
  const histogram = new Array(256).fill(0);
  let sum = 0;
  for (let i = 0; i < size; i += 1) {
    const b = buffer[i];
    histogram[b] += 1;
    sum += b;
  }

  // Entropy Shannon (0..8 bit) — ảnh nhiều chi tiết/nhiễu -> entropy cao
  let entropy = 0;
  for (let i = 0; i < 256; i += 1) {
    if (histogram[i] === 0) continue;
    const p = histogram[i] / size;
    entropy -= p * Math.log2(p);
  }

  const meanByte = sum / size; // ~ độ sáng trung bình của dữ liệu ảnh

  // 2) "Độ tối": tỉ lệ byte nằm ở nửa tối của thang
  let darkRatio = 0;
  // 3) "Độ tương phản/cạnh": tỉ lệ chuyển biến mạnh giữa 2 byte liền kề
  let edgeCount = 0;
  for (let i = 1; i < size; i += 1) {
    if (buffer[i] < 96) darkRatio += 1;
    if (Math.abs(buffer[i] - buffer[i - 1]) > 64) edgeCount += 1;
  }
  darkRatio /= size;
  const edgeRatio = edgeCount / size;

  // 4) Mật độ nén JPEG ước lượng: bytes/pixel (nếu biết kích thước)
  const pixels = (meta.width && meta.height) ? meta.width * meta.height : null;
  const bytesPerPixel = pixels ? size / pixels : null;

  return {
    size,
    entropy,
    meanByte,
    darkRatio,
    edgeRatio,
    bytesPerPixel,
    width: meta.width || null,
    height: meta.height || null
  };
}

// ------------------------------------------------------------
// Suy ra 5 chỉ số bẩn từ đặc trưng thô
// ------------------------------------------------------------
function deriveSignals(features, seed) {
  const { entropy, meanByte, darkRatio, edgeRatio, bytesPerPixel } = features;

  // entropy chuẩn hoá về 0..1 (thang thực tế ảnh ~5..8 bit)
  const entropyNorm = clamp((entropy - 5) / 3, 0, 1);

  // độ tối tổng thể: byte trung bình càng thấp -> càng tối
  const darknessNorm = clamp(1 - meanByte / 255, 0, 1);

  // mật độ chi tiết lộn xộn: cạnh càng nhiều -> nhiều vật thể/lộn xộn
  const clutterNorm = clamp(edgeRatio * 4, 0, 1);

  // mức "nhiễu hạt" (nhiều chi tiết nhỏ, thường gặp ở sàn bẩn/lông/rác)
  const grainNorm = clamp(entropyNorm * 0.6 + edgeRatio * 2, 0, 1);

  // Ảnh càng "nặng" so với số điểm ảnh -> càng nhiều chi tiết/hoa văn/nhiễu
  const weightNorm = bytesPerPixel
    ? clamp((bytesPerPixel - 0.15) / 0.85, 0, 1)
    : clamp(entropyNorm * 0.8, 0, 1);

  // Nhiễu nhỏ theo seed để tránh mọi ảnh ra cùng số (vẫn ổn định theo ảnh)
  const jitter = (stableHash(seed) - 0.5) * 12; // ±6 điểm

  const signals = {
    clutter:    clamp(35 + clutterNorm * 60 + jitter * 0.6),
    stains:     clamp(30 + darknessNorm * 45 + edgeRatio * 80 + jitter * 0.5),
    dust:       clamp(28 + grainNorm * 55 + weightNorm * 25 + jitter * 0.7),
    brightness: clamp(20 + darknessNorm * 70 + jitter * 0.4),
    debris:     clamp(25 + grainNorm * 50 + clutterNorm * 30 + jitter * 0.8)
  };

  return signals;
}

// ------------------------------------------------------------
// Tổng hợp điểm bẩn tổng từ các tín hiệu
// ------------------------------------------------------------
function computeOverallScore(signals) {
  let total = 0;
  let weightSum = 0;
  for (const [key, weight] of Object.entries(SIGNAL_WEIGHTS)) {
    if (typeof signals[key] === 'number') {
      total += signals[key] * weight;
      weightSum += weight;
    }
  }
  return weightSum > 0 ? total / weightSum : 0;
}

// ------------------------------------------------------------
// Sinh danh sách phát hiện (findings) & khuyến nghị dạng người đọc
// ------------------------------------------------------------
function buildFindings(signals) {
  const findings = [];
  const labels = {
    clutter: 'Mức độ lộn xộn / vật cản',
    stains: 'Vết bẩn, ố màu trên bề mặt',
    dust: 'Bụi bám & mảng mờ trên bề mặt',
    brightness: 'Độ sáng tổng thể (tối = lâu chưa vệ sinh)',
    debris: 'Rác, tóc, mảnh vụn trên sàn'
  };

  for (const [key, value] of Object.entries(signals)) {
    let severity = 'low';
    if (value >= 65) severity = 'high';
    else if (value >= 45) severity = 'medium';
    findings.push({
      id: key,
      label: labels[key] || key,
      score: round1(value),
      severity
    });
  }

  // Sắp xếp giảm dần theo điểm để UI hiển thị vấn đề nổi cộm trước
  findings.sort((a, b) => b.score - a.score);
  return findings;
}

function buildRecommendations(signals, level) {
  const tips = [];
  if (signals.stains >= 55) tips.push('Cần xử lý vết bẩn cứng đầu bằng dung dịch tẩy chuyên dụng.');
  if (signals.dust >= 55) tips.push('Nên lau bụi toàn bộ bề mặt, khe cửa và gầm nội thất.');
  if (signals.debris >= 55) tips.push('Hút bụi & quét sàn kỹ trước khi lau ướt.');
  if (signals.clutter >= 55) tips.push('Sắp xếp/che phủ đồ đạc để nhân viên dễ thao tác, tiết kiệm thời gian.');
  if (signals.brightness >= 60) tips.push('Không gian khá tối — nên kiểm tra thêm nấm mốc ở góc phòng.');
  if (level === 'very_heavy') tips.push('Khuyến nghị cử 2 nhân viên và chuẩn bị thiết bị chuyên dụng.');

  if (tips.length === 0) tips.push('Không gian khá sạch, chỉ cần vệ sinh định kỳ theo gói cơ bản.');
  return tips;
}

// ------------------------------------------------------------
// HÀM CHÍNH: phân tích một buffer ảnh
// ------------------------------------------------------------
async function analyzeImage(buffer, meta = {}) {
  const analyzerMode = (process.env.ANALYZER || 'builtin').toLowerCase();

  // Nếu cấu hình gọi service AI bên ngoài thì uỷ quyền cho nó
  if (analyzerMode === 'external') {
    const externalResult = await analyzeWithExternalService(buffer, meta);
    if (externalResult) return externalResult;
    // Nếu external lỗi -> rơi về builtin để không làm gián đoạn người dùng
    console.warn('[Analyzer] External analyzer lỗi, chuyển sang builtin.');
  }

  const features = extractFeatures(buffer, meta);
  const seed = `${meta.filename || ''}:${features.size}:${round1(features.entropy)}`;
  const signals = deriveSignals(features, seed);
  const overallScore = round1(computeOverallScore(signals));
  const findings = buildFindings(signals);

  return {
    analyzer: 'builtin',
    overallScore,
    signals: Object.fromEntries(
      Object.entries(signals).map(([k, v]) => [k, round1(v)])
    ),
    findings,
    features: {
      fileSizeBytes: features.size,
      entropyBits: round1(features.entropy),
      brightness: round1(100 - features.meanByte / 2.55),
      edgeRatio: round1(features.edgeRatio * 100),
      bytesPerPixel: features.bytesPerPixel ? round1(features.bytesPerPixel) : null,
      width: features.width,
      height: features.height
    }
  };
}

module.exports = {
  analyzeImage,
  extractFeatures,
  deriveSignals,
  computeOverallScore,
  buildFindings,
  buildRecommendations
};
