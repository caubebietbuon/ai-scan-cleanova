// ============================================================
// CLEANOVA AI MODULE - Bộ tính giá dịch vụ từ điểm bẩn
// ============================================================
const {
  DIRT_LEVELS,
  SERVICE_PACKAGES,
  SURCHARGES,
  PRICING
} = require('../config/businessRules');

// Xác định mức độ bẩn từ điểm tổng (0-100)
//
// LƯU Ý QUAN TRỌNG: KHÔNG dùng `find(l => score >= l.minScore && score <= l.maxScore)`
// rồi fallback về mức CUỐI. Cách đó có 2 lỗi chết người:
//   1) Điểm thập phân lọt qua khe hở giữa các dải. Ví dụ score = 24.6:
//      dải [0,24] không khớp (24.6 > 24), dải [25,44] cũng không khớp (24.6 < 25)
//      -> `find` trả undefined -> fallback về "Rất bẩn" x2.0. Nhà SẠCH bị tính
//      giá cao nhất (đúng triệu chứng: "Rất bẩn · bẩn 24/100").
//   2) NaN / undefined / số âm cũng rơi vào fallback -> luôn ra mức cao nhất.
//
// Cách đúng: kẹp điểm về [0,100] trước, rồi dò từ mức CAO xuống THẤP và lấy
// mức đầu tiên mà score >= minScore. Không còn khe hở, không còn fallback sai.
function resolveDirtLevel(score) {
  const s = Number(score);
  const safe = Number.isFinite(s) ? Math.min(100, Math.max(0, s)) : 0;

  for (let i = DIRT_LEVELS.length - 1; i >= 0; i -= 1) {
    if (safe >= DIRT_LEVELS[i].minScore) return DIRT_LEVELS[i];
  }
  return DIRT_LEVELS[0]; // chỉ tới đây khi DIRT_LEVELS rỗng
}

// Chọn gói dịch vụ phù hợp nhất với mức độ bẩn
function pickServicePackage(levelKey) {
  // Ưu tiên gói có suitableLevels chứa mức này; nếu nhiều gói, lấy gói cao hơn
  const candidates = SERVICE_PACKAGES.filter(p => p.suitableLevels.includes(levelKey));
  if (candidates.length === 0) return SERVICE_PACKAGES[0];
  return candidates[candidates.length - 1];
}

// Làm tròn giá tới đơn vị cấu hình (mặc định 1.000đ)
function roundPrice(value, unit = PRICING.roundingUnit) {
  return Math.round(value / unit) * unit;
}

// Định dạng tiền VNĐ
function formatVnd(value) {
  return `${value.toLocaleString('vi-VN')} ₫`;
}

/**
 * Tính báo giá từ kết quả phân tích ảnh + thông tin người dùng nhập.
 *
 * @param {object} analysis      - kết quả từ imageAnalyzer.analyzeImage()
 * @param {object} options       - tuỳ chọn báo giá
 * @param {number} options.areaSize        - diện tích (m2)
 * @param {string} options.urgency         - 'normal' | 'soon' | 'urgent'
 * @param {string[]} options.extras        - ['pet_hair','mold','grease','post_construction']
 * @param {boolean} options.includeVat     - có cộng VAT hay không
 * @returns {object} báo giá chi tiết
 */
function calculatePrice(analysis, options = {}) {
  const areaSize = Number(options.areaSize) > 0
    ? Number(options.areaSize)
    : PRICING.defaultAreaSize;
  const urgency = options.urgency && SURCHARGES.urgency[options.urgency]
    ? options.urgency
    : 'normal';
  const extras = Array.isArray(options.extras) ? options.extras : [];

  const level = resolveDirtLevel(analysis.overallScore);
  const pkg = pickServicePackage(level.level);

  // --- Giá gốc theo diện tích & gói dịch vụ ---
  const basePrice = pkg.basePricePerSqm * areaSize;

  // --- Nhân hệ số theo mức độ bẩn ---
  const dirtAdjusted = basePrice * level.priceMultiplier;

  // --- Phụ phí dịch vụ đặc biệt (cộng dồn %) ---
  const extrasDetail = [];
  let extrasMultiplier = 1;
  for (const key of extras) {
    if (SURCHARGES.extras[key]) {
      extrasMultiplier += SURCHARGES.extras[key];
      extrasDetail.push({
        code: key,
        percent: Math.round(SURCHARGES.extras[key] * 100)
      });
    }
  }
  const afterExtras = dirtAdjusted * extrasMultiplier;

  // --- Phụ phí gấp (urgency) ---
  const urgencyMultiplier = SURCHARGES.urgency[urgency];
  const afterUrgency = afterExtras * urgencyMultiplier;

  // --- Áp giá tối thiểu ---
  const beforeVat = Math.max(afterUrgency, PRICING.minOrderValue);

  // --- VAT (nếu có) ---
  const vatAmount = beforeVat * (PRICING.vatPercent / 100);
  const total = beforeVat + vatAmount;

  const finalPrice = roundPrice(total);

  return {
    // Kết quả chính
    dirtLevel: {
      level: level.level,
      label: level.label,
      score: analysis.overallScore,
      priceMultiplier: level.priceMultiplier
    },
    service: {
      code: pkg.code,
      name: pkg.name,
      icon: pkg.icon,
      description: pkg.description,
      pricePerSqm: pkg.basePricePerSqm
    },
    areaSize,
    urgency,
    extras: extrasDetail,

    // Bóc tách từng bước để hiển thị minh bạch cho khách
    breakdown: {
      basePrice: roundPrice(basePrice),
      basePriceLabel: formatVnd(roundPrice(basePrice)),
      afterDirtMultiplier: roundPrice(dirtAdjusted),
      dirtMultiplierLabel: `×${level.priceMultiplier}`,
      extrasMultiplier,
      extrasLabel: extrasDetail.length
        ? `+${Math.round((extrasMultiplier - 1) * 100)}%`
        : '—',
      afterExtras: roundPrice(afterExtras),
      urgencyMultiplier,
      urgencyLabel: urgencyMultiplier > 1 ? `×${urgencyMultiplier}` : '—',
      afterUrgency: roundPrice(afterUrgency),
      vatPercent: PRICING.vatPercent,
      vatAmount: roundPrice(vatAmount),
      minOrderApplied: afterUrgency < PRICING.minOrderValue
    },

    // Giá cuối cùng
    totalPrice: finalPrice,
    totalPriceLabel: formatVnd(finalPrice),

    // Khoảng giá tham khảo (±10%) để trình bày mềm mại hơn
    priceRange: {
      min: roundPrice(finalPrice * 0.9),
      max: roundPrice(finalPrice * 1.1),
      label: `${formatVnd(roundPrice(finalPrice * 0.9))} – ${formatVnd(roundPrice(finalPrice * 1.1))}`
    }
  };
}

module.exports = {
  calculatePrice,
  resolveDirtLevel,
  pickServicePackage,
  roundPrice,
  formatVnd
};
