// ============================================================
// CLEANOVA AI MODULE - Test nhanh engine phân tích & báo giá
// Chạy: node test/analyze.test.js
// ============================================================
const { analyzeImage, buildRecommendations } = require('../src/analyzer/imageAnalyzer');
const { calculatePrice } = require('../src/pricing/priceCalculator');

// Tạo buffer giả lập để test (không cần ảnh thật)
function makeFakeImage({ size = 200000, dark = false, noisy = false }) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) {
    if (noisy) buf[i] = Math.random() * 255;
    else buf[i] = dark ? 30 + (i % 20) : 200 + (i % 30);
  }
  return buf;
}

const cases = [
  { name: 'Sáng, ít chi tiết (phòng sạch)', buf: makeFakeImage({ dark: false, noisy: false }) },
  { name: 'Tối, ít chi tiết (phòng tối)', buf: makeFakeImage({ dark: true, noisy: false }) },
  { name: 'Nhiễu / nhiều chi tiết (bẩn, lộn xộn)', buf: makeFakeImage({ size: 900000, noisy: true }) }
];

(async () => {
  console.log('===== TEST PHÂN TÍCH & BÁO GIÁ =====\n');

  for (const c of cases) {
    const analysis = await analyzeImage(c.buf, { filename: c.name, width: 800, height: 600 });
    const quote = calculatePrice(analysis, { areaSize: 60, urgency: 'normal', extras: ['mold'] });
    const level = quote.dirtLevel;

    console.log(`▸ ${c.name}`);
    console.log(`  Điểm bẩn      : ${analysis.overallScore}/100`);
    console.log(`  Mức độ        : ${level.label} (${level.level})`);
    console.log(`  Gói dịch vụ   : ${quote.service.name}`);
    console.log(`  Giá đề xuất   : ${quote.totalPriceLabel}`);
    console.log(`  Khoảng giá    : ${quote.priceRange.label}`);
    console.log(`  Khuyến nghị   : ${buildRecommendations(analysis.signals, level.level)[0]}`);
    console.log('');
  }

  console.log('===== HOÀN TẤT =====');
})();
