// ============================================================
// CLEANOVA AI MODULE - Cấu hình nghiệp vụ (giá, độ bẩn, dịch vụ)
// ============================================================
// Tất cả con số điều chỉnh giá tập trung ở đây để nhóm dễ tinh chỉnh
// mà không phải sửa logic trong analyzer/priceCalculator.
// ============================================================

// --- Ngưỡng điểm bẩn (0-100) -> mức độ ---
// Dải liền mạch: mỗi mức bắt đầu từ minScore và kéo tới SÁT mức kế tiếp.
// maxScore chỉ để tham chiếu/hiển thị — resolveDirtLevel() dò theo minScore
// nên không phụ thuộc maxScore, tránh khe hở với điểm thập phân.
const DIRT_LEVELS = [
  { level: 'clean',     label: 'Sạch',        minScore: 0,  maxScore: 24.99, priceMultiplier: 1.0 },
  { level: 'light',     label: 'Bẩn nhẹ',     minScore: 25, maxScore: 44.99, priceMultiplier: 1.15 },
  { level: 'moderate',  label: 'Bẩn vừa',     minScore: 45, maxScore: 64.99, priceMultiplier: 1.35 },
  { level: 'heavy',     label: 'Bẩn nặng',    minScore: 65, maxScore: 84.99, priceMultiplier: 1.6 },
  { level: 'very_heavy',label: 'Rất bẩn',     minScore: 85, maxScore: 100,   priceMultiplier: 2.0 }
];

// --- Gói dịch vụ gợi ý (đơn giá theo m2, VNĐ) ---
// Đây là bảng giá RIÊNG của module AI; khi tích hợp chính thức có thể
// thay bằng dữ liệu lấy từ bảng `services` của backend chính.
const SERVICE_PACKAGES = [
  {
    code: 'basic',
    name: 'Dọn dẹp cơ bản',
    icon: '🧹',
    basePricePerSqm: 12000,
    suitableLevels: ['clean', 'light'],
    description: 'Quét dọn, lau sàn, hút bụi, dọn bề mặt — phù hợp vệ sinh định kỳ.'
  },
  {
    code: 'standard',
    name: 'Dọn dẹp tiêu chuẩn',
    icon: '🧼',
    basePricePerSqm: 18000,
    suitableLevels: ['light', 'moderate'],
    description: 'Bao gồm cơ bản + lau kính, vệ sinh nhà bếp, phòng tắm, khử mùi.'
  },
  {
    code: 'deep',
    name: 'Dọn dẹp sâu',
    icon: '🫧',
    basePricePerSqm: 27000,
    suitableLevels: ['moderate', 'heavy'],
    description: 'Xử lý vết bẩn cứng đầu, vệ sinh khe ron, trần, quạt, gầm nội thất.'
  },
  {
    code: 'premium',
    name: 'Dọn dẹp chuyên sâu / Tổng vệ sinh',
    icon: '✨',
    basePricePerSqm: 38000,
    suitableLevels: ['heavy', 'very_heavy'],
    description: 'Tổng vệ sinh toàn diện, xử lý nấm mốc, khử khuẩn, đánh bóng bề mặt.'
  }
];

// --- Hệ số phụ phí ---
const SURCHARGES = {
  // Phụ phí theo mức độ bẩn (nhân thêm sau khi chọn gói)
  // Giữ bằng 1.0 vì đã thể hiện trong priceMultiplier; đổi nếu muốn tách riêng.
  urgency: {
    normal: 1.0,     // đặt trước >= 2 ngày
    soon: 1.1,       // trong vòng 24-48h
    urgent: 1.25     // trong 24h
  },
  // Phụ phí dịch vụ đặc biệt (cộng dồn theo checkbox)
  extras: {
    pet_hair: 0.08,     // nhiều lông thú cưng
    mold: 0.15,         // nấm mốc
    grease: 0.12,       // dầu mỡ nhà bếp
    post_construction: 0.25 // sau xây dựng/sửa chữa
  }
};

// --- Tham số chung ---
const PRICING = {
  minOrderValue: 150000,   // giá tối thiểu mỗi đơn (VNĐ)
  vatPercent: 0,           // % VAT nếu cần xuất hoá đơn (0 = không tính)
  roundingUnit: 1000,      // làm tròn giá tới 1.000đ
  defaultAreaSize: 60      // m2 mặc định khi người dùng không khai báo
};

// --- Trọng số cho từng tín hiệu phân tích ảnh (tổng = 1.0) ---
const SIGNAL_WEIGHTS = {
  clutter:    0.20,  // nhiều đồ đạc/vật cản -> khó dọn
  stains:     0.25,  // vết bẩn, ố vàng, loang lổ
  dust:       0.20,  // bụi bám bề mặt
  brightness: 0.15,  // độ sáng/tối tổng thể (tối = ít được vệ sinh)
  debris:     0.20   // rác, tóc, mảnh vụn trên sàn
};

module.exports = {
  DIRT_LEVELS,
  SERVICE_PACKAGES,
  SURCHARGES,
  PRICING,
  SIGNAL_WEIGHTS
};
