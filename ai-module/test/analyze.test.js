// ============================================================
// CLEANOVA AI MODULE - Test nhanh engine phân tích & báo giá
// Chạy: node test/analyze.test.js
// ============================================================
// Test này tự SINH ảnh JPEG/PNG thật (không dùng file ngoài) để kiểm tra
// analyzer có phân biệt được phòng sạch và phòng bẩn hay không.
// ============================================================
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const { analyzeImage, buildRecommendations } = require('../src/analyzer/imageAnalyzer');
const { calculatePrice, resolveDirtLevel } = require('../src/pricing/priceCalculator');
const { DIRT_LEVELS } = require('../src/config/businessRules');

// ============================================================
// TEST HỒI QUY: phân loại mức bẩn phải liền mạch & đơn điệu
// ============================================================
// Lỗi đã từng mắc: DIRT_LEVELS dùng `<=` cả hai đầu nên điểm thập phân LỌT
// KHE HỞ giữa các dải (vd 24.6 không thuộc [0,24] lẫn [25,44]), và fallback
// `|| DIRT_LEVELS[last]` đẩy thẳng lên "Rất bẩn" x2.0. Nhà sạch bị tính giá
// cao nhất. Test này chốt lại để lỗi không quay về.
function testDirtLevelMapping() {
  const checks = [];
  const push = (label, ok) => checks.push([label, ok]);

  // 1) Các điểm TỪNG lọt khe hở phải ra mức thấp đúng, không phải x2.0
  push('24.6 -> "Sạch" x1.0 (từng lọt khe hở ra x2.0)',
    resolveDirtLevel(24.6).priceMultiplier === 1.0);
  push('44.9 -> "Bẩn nhẹ" x1.15',
    resolveDirtLevel(44.9).level === 'light');
  push('64.9 -> "Bẩn vừa" x1.35',
    resolveDirtLevel(64.9).level === 'moderate');
  push('84.9 -> "Bẩn nặng" x1.6',
    resolveDirtLevel(84.9).level === 'heavy');

  // 2) Giá trị hỏng phải rơi về mức THẤP NHẤT, không phải cao nhất
  push('NaN -> "Sạch" (không phải x2.0)',
    resolveDirtLevel(NaN).priceMultiplier === 1.0);
  push('undefined -> "Sạch"',
    resolveDirtLevel(undefined).priceMultiplier === 1.0);
  push('-50 -> "Sạch"',
    resolveDirtLevel(-50).priceMultiplier === 1.0);
  push('150 -> "Rất bẩn" (kẹp về 100)',
    resolveDirtLevel(150).level === 'very_heavy');

  // 3) Quét toàn dải: hệ số nhân KHÔNG được giảm khi điểm tăng
  let monotonic = true;
  let prev = resolveDirtLevel(0).priceMultiplier;
  for (let s = 0; s <= 100; s += 0.1) {
    const cur = resolveDirtLevel(Math.round(s * 10) / 10).priceMultiplier;
    if (cur < prev) monotonic = false;
    prev = cur;
  }
  push('Hệ số nhân đơn điệu tăng suốt 0..100 (bước 0.1)', monotonic);

  // 4) Mọi điểm trong 0..100 phải khớp ĐÚNG một dải (không hở)
  let gaps = 0;
  for (let s = 0; s <= 100; s += 0.05) {
    const v = Math.round(s * 100) / 100;
    const hits = DIRT_LEVELS.filter(l => v >= l.minScore && v <= l.maxScore);
    if (hits.length !== 1) gaps += 1;
  }
  push('Không có khe hở/chồng lấn giữa các dải (theo min/maxScore)', gaps === 0);

  return checks;
}

const W = 320;
const H = 240;

// Bộ sinh số ngẫu nhiên có seed -> ảnh tái lập được giữa các lần chạy
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Tạo ảnh RGBA từ hàm vẽ pixel
function renderImage(painter) {
  const data = Buffer.alloc(W * H * 4);
  const rnd = makeRng(12345);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      const [r, g, b] = painter(x, y, rnd);
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

function toJpeg(img, quality = 85) {
  return { buffer: jpeg.encode(img, quality).data, meta: { mimetype: 'image/jpeg' } };
}

function toPng(img) {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  return { buffer: PNG.sync.write(png), meta: { mimetype: 'image/png' } };
}

// ---------- Kịch bản ảnh ----------

// 1) PHÒNG SẠCH: tường sáng đều, ít chi tiết, màu trung tính
const cleanRoom = renderImage((x, y, rnd) => {
  const base = 205 - (y / H) * 25;          // gradient dọc nhẹ
  const n = rnd() * 4;                       // nhiễu rất nhỏ
  return [base + n, base + n + 1, base + n + 3];
});

// 2) PHÒNG TỐI: cùng cấu trúc nhưng thiếu sáng
const darkRoom = renderImage((x, y, rnd) => {
  const base = 62 - (y / H) * 15;
  const n = rnd() * 4;
  return [base + n, base + n, base + n + 4];
});

// 4) PHÒNG BẨN VỪA: vết ố mức trung bình + rác vụn lấm tấm.
//    (Ảnh "bẩn nặng" thật sự là veryDirtyRoom bên dưới.)
const dirtyRoom = renderImage((x, y, rnd) => {
  let r = 150, g = 138, b = 118;            // nền tường ngả vàng bẩn

  // vết ố lớn (mảng tối bất thường)
  const stain = Math.sin(x / 23) * Math.cos(y / 17);
  if (stain > 0.35) { r -= 62; g -= 55; b -= 40; }
  if (stain < -0.5)  { r -= 40; g -= 34; b -= 26; }

  // rác vụn: hạt tối sáng đan xen ngẫu nhiên
  if (rnd() < 0.16) {
    const k = rnd() * 90 - 45;
    r += k; g += k; b += k * 0.8;
  }

  // vệt ố vàng bão hoà màu
  if (Math.abs(Math.sin(x / 9 + y / 13)) > 0.85) { r += 55; g += 22; b -= 30; }

  return [Math.max(0, Math.min(255, r)),
          Math.max(0, Math.min(255, g)),
          Math.max(0, Math.min(255, b))];
});

// 4) PHÒNG LỘN XỘN: nền sáng nhưng nhiều cạnh mạnh (đồ đạc chồng chéo)
const clutteredRoom = renderImage((x, y, rnd) => {
  const cell = ((x / 18) | 0) + ((y / 14) | 0);
  const base = cell % 2 === 0 ? 45 : 225;
  const n = rnd() * 6;
  return [base + n, base + n, base + n];
});

// 5) PHÒNG RẤT BẨN: vết ố đậm đặc, mảng mốc đen, rác dày, tông màu bẩn nặng.
//    Đây là ca "rất bẩn" để kiểm tra trần trên của thang điểm.
const veryDirtyRoom = renderImage((x, y, rnd) => {
  let r = 118, g = 104, b = 84;

  // vết ố đậm đặc, mật độ cao
  const stain = Math.sin(x / 11) * Math.cos(y / 9) + Math.sin((x + y) / 17);
  if (stain > 0.1) { r -= 85; g -= 78; b -= 60; }

  // mảng mốc đen lớn
  if (Math.sin(x / 27) * Math.sin(y / 31) > 0.55) { r -= 45; g -= 45; b -= 40; }

  // rác vụn dày đặc
  if (rnd() < 0.3) {
    const k = rnd() * 130 - 65;
    r += k; g += k; b += k * 0.7;
  }

  // vệt ố vàng/nâu bão hoà
  if (Math.abs(Math.sin(x / 7 - y / 11)) > 0.6) { r += 70; g += 30; b -= 45; }

  return [Math.max(0, Math.min(255, r)),
          Math.max(0, Math.min(255, g)),
          Math.max(0, Math.min(255, b))];
});

// 6) PHÒNG SẠCH CÓ KẾT CẤU: sàn gỗ vân đều + thảm sợi đều + nội thất gọn.
//    Đây là ca quan trọng nhất — kết cấu bề mặt KHÔNG được tính là bụi bẩn.
const cleanTexturedRoom = renderImage((x, y, rnd) => {
  let r, g, b;

  if (y < H * 0.55) {
    // Vùng tường sơn sáng, phẳng
    const base = 208 - (y / H) * 20;
    r = base; g = base; b = base + 3;
  } else {
    // Vùng sàn gỗ: vân dọc ĐỀU ĐẶN, lặp lại có chu kỳ (không phải bụi ngẫu nhiên)
    const woodBase = 168;
    const grainLine = Math.sin(x / 2.5) * 5 + Math.sin(x / 7) * 3;
    r = woodBase + grainLine;
    g = woodBase - 26 + grainLine;
    b = woodBase - 58 + grainLine;
    // Khe ván gỗ: cạnh mạnh nhưng ĐỀU ĐẶN theo chu kỳ cố định
    if (x % 26 === 0) { r -= 42; g -= 40; b -= 34; }
  }

  // Thảm sợi ở góc dưới: nhiễu mịn ĐỀU KHẮP (kết cấu, không phải bụi lấm tấm)
  if (x < W * 0.35 && y > H * 0.72) {
    const weave = (Math.sin(x * 1.9) + Math.sin(y * 1.7)) * 7;
    r = 196 + weave; g = 190 + weave; b = 176 + weave;
  }

  const n = rnd() * 3; // nhiễu cảm biến rất nhỏ
  return [Math.max(0, Math.min(255, r + n)),
          Math.max(0, Math.min(255, g + n)),
          Math.max(0, Math.min(255, b + n))];
});

// 7) PHÒNG SẠCH NHƯNG CÓ BỤI THẬT: nền phẳng sáng + vài ĐÁM bụi lấm tấm thưa.
//    Ca này phải báo bụi CAO, để chứng minh phân biệt được với ca kết cấu ở trên.
const dustyFlatRoom = renderImage((x, y, rnd) => {
  const base = 205 - (y / H) * 18;
  let r = base, g = base, b = base + 2;

  // 3 đám bụi ngẫu nhiên, thưa thớt, kích thước khác nhau
  const patches = [
    { cx: 60,  cy: 80,  rad: 34 },
    { cx: 240, cy: 150, rad: 46 },
    { cx: 150, cy: 200, rad: 26 }
  ];
  for (const pt of patches) {
    const d = Math.hypot(x - pt.cx, y - pt.cy);
    if (d < pt.rad && rnd() < 0.55) {
      const k = -(12 + rnd() * 40); // hạt bụi tối lấm tấm
      r += k; g += k; b += k * 0.9;
    }
  }

  const n = rnd() * 3;
  return [Math.max(0, Math.min(255, r + n)),
          Math.max(0, Math.min(255, g + n)),
          Math.max(0, Math.min(255, b + n))];
});

const cases = [
  { name: 'Phòng sạch (tường sáng, ít chi tiết)', img: cleanRoom, fmt: 'jpeg' },
  { name: 'Phòng sạch (PNG)',                     img: cleanRoom, fmt: 'png'  },
  { name: 'Phòng sạch CÓ KẾT CẤU (gỗ + thảm)',    img: cleanTexturedRoom, fmt: 'jpeg' },
  { name: 'Phòng sạch CÓ BỤI THẬT (lấm tấm)',     img: dustyFlatRoom, fmt: 'jpeg' },
  { name: 'Phòng tối (thiếu sáng)',               img: darkRoom,  fmt: 'jpeg' },
  { name: 'Phòng bẩn nặng (vết ố + rác vụn)',     img: dirtyRoom, fmt: 'jpeg' },
  { name: 'Phòng RẤT bẩn (mốc + ố đậm + rác dày)', img: veryDirtyRoom, fmt: 'jpeg' },
  { name: 'Phòng lộn xộn (nhiều đồ đạc)',         img: clutteredRoom, fmt: 'jpeg' }
];

(async () => {
  console.log('===== TEST PHÂN TÍCH & BÁO GIÁ =====\n');

  let cleanScore = null;
  let texturedScore = null;
  let texturedDust = null;
  let dustyScore = null;
  let dustyDust = null;
  let dirtyScore = null;
  let veryDirtyScore = null;
  let clutterScore = null;

  for (const c of cases) {
    const { buffer, meta } = c.fmt === 'png' ? toPng(c.img) : toJpeg(c.img);
    const fullMeta = { ...meta, filename: `${c.name}.${c.fmt}`, size: buffer.length };

    const analysis = await analyzeImage(buffer, fullMeta);
    const quote = calculatePrice(analysis, { areaSize: 60, urgency: 'normal', extras: ['mold'] });
    const level = quote.dirtLevel;
    const f = analysis.features;

    console.log(`▸ ${c.name}`);
    console.log(`  Giải mã pixel : ${f.decoded ? 'OK' : 'THẤT BẠI'}`);
    console.log(`  Điểm bẩn      : ${analysis.overallScore}/100  →  ${level.label} (${level.level})`);
    console.log(`  Chỉ số        : ${Object.entries(analysis.signals).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    if (f.decoded) {
      console.log(`  Đặc trưng     : grain=${f.grain} density=${f.grainDensityPercent}%` +
                  ` spread=${f.grainSpreadPercent}% dustness=${f.dustnessPercent}%` +
                  ` texture=${f.texturePercent}%`);
      console.log(`  Quy mô lớn    : patch=${f.patchiness} period=${f.periodicityPercent}%` +
                  ` mottle=${f.mottlePercent}% darkRatio=${f.darkRatioPercent}%`);
    }
    console.log(`  Gói dịch vụ   : ${quote.service.icon} ${quote.service.name}`);
    console.log(`  Giá đề xuất   : ${quote.totalPriceLabel}   (khoảng ${quote.priceRange.label})`);
    console.log('');

    if (c.name.includes('ít chi tiết')) cleanScore = analysis.overallScore;
    if (c.name.includes('CÓ KẾT CẤU')) {
      texturedScore = analysis.overallScore;
      texturedDust = analysis.signals.dust;
    }
    if (c.name.includes('CÓ BỤI THẬT')) {
      dustyScore = analysis.overallScore;
      dustyDust = analysis.signals.dust;
    }
    if (c.name.includes('bẩn nặng')) dirtyScore = analysis.overallScore;
    if (c.name.includes('RẤT bẩn')) veryDirtyScore = analysis.overallScore;
    if (c.name.includes('lộn xộn')) clutterScore = analysis.overallScore;
  }

  let failed = 0;

  // --- Phần A: phân loại mức bẩn (hồi quy lỗi khe hở / nhảy mức) ---
  console.log('===== KIỂM TRA PHÂN LOẠI MỨC BẨN (hồi quy) =====');
  for (const [label, ok] of testDirtLevelMapping()) {
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}`);
    if (!ok) failed += 1;
  }
  console.log('');

  // --- Phần B: tính nhất quán giá — điểm thấp hơn KHÔNG được đắt hơn ---
  console.log('===== KIỂM TRA NHẤT QUÁN GIÁ =====');
  // Đây chính là triệu chứng người dùng báo: "nhà sạch lại hệ số đắt hơn nhà bẩn".
  const cleanQuote = calculatePrice({ overallScore: cleanScore, signals: {}, findings: [] },
    { areaSize: 10, urgency: 'normal', extras: [] });
  const dirtyQuote = calculatePrice({ overallScore: dirtyScore, signals: {}, findings: [] },
    { areaSize: 10, urgency: 'normal', extras: [] });
  const veryDirtyQuote = calculatePrice({ overallScore: veryDirtyScore, signals: {}, findings: [] },
    { areaSize: 10, urgency: 'normal', extras: [] });

  console.log(`  Điểm ${cleanScore} -> x${cleanQuote.dirtLevel.priceMultiplier} -> ${cleanQuote.totalPriceLabel}`);
  console.log(`  Điểm ${dirtyScore} -> x${dirtyQuote.dirtLevel.priceMultiplier} -> ${dirtyQuote.totalPriceLabel}`);
  console.log(`  Điểm ${veryDirtyScore} -> x${veryDirtyQuote.dirtLevel.priceMultiplier} -> ${veryDirtyQuote.totalPriceLabel}`);

  const consistencyChecks = [
    ['Hệ số ảnh bẩn >= hệ số ảnh sạch',
      dirtyQuote.dirtLevel.priceMultiplier >= cleanQuote.dirtLevel.priceMultiplier],
    ['Giá ảnh bẩn >= giá ảnh sạch',
      dirtyQuote.totalPrice >= cleanQuote.totalPrice],
    ['Hệ số ảnh RẤT bẩn >= hệ số ảnh bẩn nặng',
      veryDirtyQuote.dirtLevel.priceMultiplier >= dirtyQuote.dirtLevel.priceMultiplier],
    ['Giá ảnh RẤT bẩn >= giá ảnh bẩn nặng',
      veryDirtyQuote.totalPrice >= dirtyQuote.totalPrice]
  ];
  for (const [label, ok] of consistencyChecks) {
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}`);
    if (!ok) failed += 1;
  }
  console.log('');

  console.log('===== KIỂM TRA TÍNH PHÂN BIỆT =====');
  const gap = dirtyScore - cleanScore;
  console.log(`Điểm sạch (phẳng)      : ${cleanScore}`);
  console.log(`Điểm sạch (có kết cấu) : ${texturedScore}   [dust=${texturedDust}]`);
  console.log(`Điểm sạch (có bụi thật): ${dustyScore}   [dust=${dustyDust}]`);
  console.log(`Điểm bẩn nặng          : ${dirtyScore}`);
  console.log(`Điểm RẤT bẩn           : ${veryDirtyScore}\n`);

  const checks = [
    ['Ảnh sạch phẳng < 25 điểm (mức "Sạch")', cleanScore < 25],
    ['Ảnh sạch có KẾT CẤU (gỗ/thảm) < 35 điểm — không bị coi là bẩn', texturedScore < 35],
    ['Kết cấu (gỗ/thảm) không bị tính là BỤI (dust < 45)', texturedDust < 45],
    ['Ảnh sạch CÓ BỤI THẬT phải báo bụi cao (dust > 55)', dustyDust > 55],
    ['Bụi thật phải cao hơn kết cấu ít nhất 20 điểm (dust)', dustyDust - texturedDust >= 20],
    ['Ảnh bẩn nặng (vừa phải) >= 25 điểm, "Bẩn nhẹ" trở lên', dirtyScore >= 25],
    ['Ảnh RẤT bẩn >= 65 điểm (mức "Bẩn nặng" trở lên)', veryDirtyScore >= 65],
    ['Khoảng cách sạch/bẩn nặng >= 20 điểm', gap >= 20],
    ['Ảnh lộn xộn cao hơn ảnh sạch', clutterScore > cleanScore],
    ['Ảnh RẤT bẩn cao hơn ảnh bẩn nặng', veryDirtyScore > dirtyScore]
  ];

  for (const [label, ok] of checks) {
    console.log(`${ok ? '  ✓' : '  ✗'} ${label}`);
    if (!ok) failed += 1;
  }

  console.log('');
  if (failed === 0) {
    console.log('===== TẤT CẢ KIỂM TRA ĐỀU ĐẠT =====');
  } else {
    console.log(`===== CÓ ${failed} KIỂM TRA KHÔNG ĐẠT =====`);
    process.exitCode = 1;
  }
})();
