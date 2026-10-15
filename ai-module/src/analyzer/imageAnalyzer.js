// ============================================================
// CLEANOVA AI MODULE - Bộ máy phân tích ảnh phòng (Built-in Analyzer)
// ============================================================
// Đây là analyzer "built-in": không cần GPU / API key, chạy thuần Node.js.
//
// Cách hoạt động:
// 1. GIẢI MÃ ảnh thành lưới pixel thật (RGB) bằng jpeg-js / pngjs.
//    -> Không còn đo trên byte nén, vì byte JPEG nhảy loạn xạ và gây
//       kết quả sai (mọi ảnh đều ra ~90 điểm).
// 2. Trích đặc trưng thị giác thật trên pixel:
//      - độ sáng trung bình & histogram luma
//      - độ tương phản cục bộ (biến thiên luma giữa 2 pixel kề nhau)
//      - tỉ lệ pixel tối bất thường (mảng bẩn / bóng đổ)
//      - "nhiễu hạt": phương sai tần số cao (bụi, tóc, vết lốm đốm)
//      - độ bão hoà màu (vết ố vàng/nâu làm lệch tông màu)
//      - mức độ lộn xộn: tỉ lệ cạnh mạnh trên toàn khung hình
// 3. Chuẩn hoá từng đặc trưng về 0..1 bằng hàm mềm (smoothstep) với
//    ngưỡng thực nghiệm, rồi mới đưa lên thang 0..100.
//    -> Phòng sạch (~10-25), phòng bẩn nặng (~75-95), dải rộng và phân biệt được.
//
// LƯU Ý: Đây vẫn là mô hình heuristic (thống kê đặc trưng ảnh), KHÔNG phải
// mạng nơ-ron. Nó phân biệt được sạch/bẩn ở mức tương đối nhưng không "hiểu"
// ngữ nghĩa (không biết đó là vết cà phê hay hoa văn thảm).
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

// smoothstep: ánh xạ x từ [lo,hi] về [0,1] với hai đầu mượt.
// Đây là "núm vặn" chính để hiệu chỉnh độ nhạy: x <= lo -> 0, x >= hi -> 1.
// (lo phải nhỏ hơn hi.)
function smoothstep(x, lo, hi) {
  if (hi === lo) return x >= hi ? 1 : 0;
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

// Bản đảo chiều: dùng khi "càng NHỎ càng bẩn" (ví dụ độ sáng trung bình).
// x >= hi -> 0 (không phải vấn đề); x <= lo -> 1 (vấn đề nặng).
// Viết riêng hàm này thay vì thêm cờ `invert`, để tránh nhầm lẫn thứ tự tham số.
function smoothstepInv(x, lo, hi) {
  return smoothstep(-x, -hi, -lo);
}

// Giải mã ảnh thành { width, height, luma[], rgb[] } — luma 0..255
function decodeToPixels(buffer, mimetype = '') {
  const type = (mimetype || '').toLowerCase();

  try {
    if (type.includes('png')) {
      const { PNG } = require('pngjs');
      const png = PNG.sync.read(buffer);
      return { width: png.width, height: png.height, data: png.data, channels: 4 };
    }

    // Mặc định thử JPEG (phổ biến nhất); nếu là định dạng khác (webp/gif/bmp)
    // thì jpeg-js sẽ ném lỗi -> rơi xuống nhánh null bên dưới.
    const jpeg = require('jpeg-js');
    const raw = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 512 });
    return { width: raw.width, height: raw.height, data: raw.data, channels: 4 };
  } catch (err) {
    return null;
  }
}

// ------------------------------------------------------------
// Trích đặc trưng thô từ buffer ảnh
// ------------------------------------------------------------
function extractFeatures(buffer, meta = {}) {
  const size = buffer.length;
  const decoded = decodeToPixels(buffer, meta.mimetype);

  // --- Đặc trưng trên byte nén (dùng làm dự phòng nếu không giải mã được) ---
  const histogram = new Array(256).fill(0);
  let byteSum = 0;
  for (let i = 0; i < size; i += 1) {
    histogram[buffer[i]] += 1;
    byteSum += buffer[i];
  }
  let byteEntropy = 0;
  for (let i = 0; i < 256; i += 1) {
    if (histogram[i] === 0) continue;
    const p = histogram[i] / size;
    byteEntropy -= p * Math.log2(p);
  }

  if (!decoded) {
    // Ảnh không giải mã được (webp/gif/bmp/ảnh hỏng): dùng heuristics byte,
    // nhưng ghi rõ trong features để không gây hiểu nhầm là đã phân tích pixel.
    return {
      decoded: false,
      size,
      width: null,
      height: null,
      bytesPerPixel: null,
      byteEntropy: round1(byteEntropy),
      meanByte: round1(byteSum / size),
      lumaMean: null,
      contrast: null,
      darkRatio: null,
      grain: null,
      saturation: null,
      edgeRatio: null,
      meanByteRaw: byteSum / size,
      byteEntropyRaw: byteEntropy
    };
  }

  // --- Đặc trưng trên PIXEL THẬT ---
  const { width, height, data, channels } = decoded;
  const total = width * height;

  let lumaSum = 0;
  let chromaSum = 0;
  const luma = new Float32Array(total); // luma từng pixel, 0..255

  for (let p = 0; p < total; p += 1) {
    const i = p * channels;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Luma theo ITU-R BT.601
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    luma[p] = y;
    lumaSum += y;

    // Bão hoà (max-min của kênh màu) — vết ố/nấm mốc làm lệch tông rõ
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    chromaSum += (mx - mn);
  }

  const lumaMean = lumaSum / total;
  const saturation = chromaSum / total; // 0..255

  // Đổ histogram luma 32 bin để đo độ "trải" tông và tìm mảng tối bất thường
  const bins = new Array(32).fill(0);
  for (let p = 0; p < total; p += 1) {
    bins[Math.min(31, (luma[p] / 8) | 0)] += 1;
  }

  // --- Quét theo hàng: độ tương phản cục bộ, cạnh mạnh, nhiễu hạt ---
  let contrastSum = 0;
  let edgeStrong = 0;
  let grainSum = 0;
  let darkPixels = 0;
  let neighborCount = 0;
  let grainCount = 0;

  const DARK_THRESHOLD = 45; // luma dưới ngưỡng này coi là "tối bất thường"
  const GRAIN_LOW = 8;       // biến thiên nhỏ => nhiễu hạt/bụi
  const GRAIN_HIGH = 60;     // biến thiên lớn => cạnh vật thể thật

  // --- Phân biệt KẾT CẤU BỀ MẶT với BỤI BẨN ---
  // Vân gỗ, sợi thảm, hoa văn gạch: biến thiên xuất hiện DÀY ĐẶC và LẶP LẠI ĐỀU.
  // Bụi, tóc, rác vụn: biến thiên THƯA THỚT và NGẪU NHIÊN, thành từng cụm nhỏ.
  // Ta đo hai thứ:
  //   - grainDensity: tỉ lệ pixel có biến thiên hạt trên tổng số cặp láng giềng.
  //   - grainBurst:   mức độ "cục bộ" — tỉ lệ ô vuông 3x3 có hạt so với toàn cục.
  // Kết cấu thật -> density cao. Bụi thật -> density thấp, burst cao (từng đám).
  // Ô vuông 3x3 đếm hạt, dùng lưới thô để không tốn quá nhiều bộ nhớ.
  const BLOCK = 3;
  const bw = Math.max(1, Math.floor(width / BLOCK));
  const bh = Math.max(1, Math.floor(height / BLOCK));
  const blockGrain = new Float32Array(bw * bh); // mật độ hạt mỗi ô
  const blockCount = new Int32Array(bw * bh);   // số mẫu mỗi ô
  const blockLuma = new Float32Array(bw * bh);  // tổng luma mỗi ô
  const blockLumaN = new Int32Array(bw * bh);   // số pixel mỗi ô

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width;
    const by = Math.min(bh - 1, (y / BLOCK) | 0);
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + x;
      const cur = luma[p];
      if (cur < DARK_THRESHOLD) darkPixels += 1;
      const bx = Math.min(bw - 1, (x / BLOCK) | 0);
      const bi = by * bw + bx;
      blockLuma[bi] += cur;
      blockLumaN[bi] += 1;

      // So với pixel bên phải
      if (x + 1 < width) {
        const d = Math.abs(cur - luma[p + 1]);
        contrastSum += d;
        neighborCount += 1;
        if (d > 64) edgeStrong += 1;
        if (d >= GRAIN_LOW && d <= GRAIN_HIGH) {
          grainSum += d; grainCount += 1;
          blockGrain[bi] += 1;
        }
        blockCount[bi] += 1;
      }
      // So với pixel bên dưới
      if (y + 1 < height) {
        const d = Math.abs(cur - luma[p + width]);
        contrastSum += d;
        neighborCount += 1;
        if (d > 64) edgeStrong += 1;
        if (d >= GRAIN_LOW && d <= GRAIN_HIGH) {
          grainSum += d; grainCount += 1;
          blockGrain[bi] += 1;
        }
        blockCount[bi] += 1;
      }
    }
  }

  const contrast = neighborCount ? contrastSum / neighborCount : 0; // 0..255
  const edgeRatio = neighborCount ? edgeStrong / neighborCount : 0;  // 0..1
  const grain = grainCount ? grainSum / grainCount : 0;              // 0..~60
  const darkRatio = darkPixels / total;                              // 0..1

  // Mật độ hạt: nếu KẾT CẤU dày đặc thì nhiều cặp pixel có biến thiên.
  // Thang thực tế đo được: ảnh phẳng ~0%, ảnh có kết cấu ~5-15%, ảnh rất chi tiết ~20-60%.
  const grainDensity = neighborCount ? grainCount / neighborCount : 0; // 0..1

  // Tính mật độ hạt trung bình toàn ảnh & độ lệch chuẩn giữa các ô.
  // Kết cấu phủ đều khắp ảnh -> mọi ô đều có hạt -> spread THẤP.
  // Bụi lấm tấm -> ô có ô không -> spread CAO.
  let grainMean = 0;
  let validBlocks = 0;
  for (let i = 0; i < blockGrain.length; i += 1) {
    if (blockCount[i] === 0) continue;
    grainMean += blockGrain[i] / blockCount[i];
    validBlocks += 1;
  }
  grainMean = validBlocks ? grainMean / validBlocks : 0;

  let grainVar = 0;
  for (let i = 0; i < blockGrain.length; i += 1) {
    if (blockCount[i] === 0) continue;
    const v = blockGrain[i] / blockCount[i];
    grainVar += (v - grainMean) ** 2;
  }
  const grainSpread = validBlocks ? Math.sqrt(grainVar / validBlocks) : 0;

  // ---- Kết cấu vs bụi: hai thái cực, dùng hai tín hiệu độc lập ----
  // a) Mức phủ: kết cấu phủ đều phần lớn bề mặt, bụi chỉ phủ vài đám nhỏ.
  //    Ngưỡng hiệu chỉnh theo thang thực tế (không phải 0.25-0.75 như bản sai trước).
  const coverage = smoothstep(grainDensity, 0.01, 0.08);

  // b) Độ đều: kết cấu cho hạt ĐỒNG NHẤT giữa các ô, bụi cho spread lớn.
  //    So spread TUYỆT ĐỐI (0..1) với ngưỡng thực nghiệm.
  const evenness = 1 - smoothstep(grainSpread, 0.10, 0.40);

  // texture: hạt phủ rộng VÀ đều -> giống kết cấu bề mặt (gỗ, thảm, gạch).
  const textureRaw = clamp(coverage * evenness, 0, 1);

  // NHƯNG: kết cấu đều đặn trên một NỀN XẤU (tối bất thường, ố màu, mảng mốc)
  // vẫn là bẩn — không được tha. Nền sạch là điều kiện tiên quyết.
  // Đo "độ sạch của nền": sáng vừa phải, ít mảng tối, ít bão hoà màu lệch.
  const baseHealthy = (1 - smoothstepInv(lumaMean, 60, 130))     // nền không quá tối
                    * (1 - smoothstep(darkRatio, 8, 30))          // ít mảng tối
                    * (1 - smoothstep(saturation, 45, 85));       // ít ố màu đậm
  const texture = clamp(textureRaw * baseHealthy, 0, 1);

  // dustness: ngược lại — càng phân tán/cục bộ càng giống bụi.
  // hasGrain chặn trường hợp ảnh phẳng hoàn toàn (không có hạt thì không có bụi).
  const hasGrain = smoothstep(grain, 1.5, 12);
  const dustness = clamp(((1 - texture) + (1 - evenness) * 0.35) * hasGrain, 0, 1);

  // ---- MẢNG MỜ / LOANG LỔ (quy mô lớn) ----
  // Tên chỉ số là "Bụi bám & MẢNG MỜ" nhưng phần trên chỉ đo hạt mịn. Bụi phủ
  // thành vệt/mảng, ố loang, vũng bẩn tạo biến thiên ở QUY MÔ LỚN, không tạo hạt.
  // Ta đo độ lệch luma giữa các Ô LÂN CẬN trên lưới thô:
  //   - Vân gỗ/sợi thảm đều -> ô kề nhau gần như nhau -> patchiness thấp.
  //   - Bụi phủ thành đám, ố loang, đồ đạc lộn xộn -> ô kề nhau lệch mạnh.
  let patchSum = 0;
  let patchN = 0;

  // Bước 1: đo độ lệch luma giữa các Ô KỀ NHAU (patchiness).
  // Đây là mốc "không khớp chút nào" để so sánh ở bước 2.
  for (let by = 0; by < bh; by += 1) {
    for (let bx = 0; bx < bw; bx += 1) {
      const i = by * bw + bx;
      if (blockLumaN[i] === 0) continue;
      const cur = blockLuma[i] / blockLumaN[i];
      if (bx + 1 < bw && blockLumaN[i + 1] > 0) {
        patchSum += Math.abs(cur - blockLuma[i + 1] / blockLumaN[i + 1]);
        patchN += 1;
      }
      if (by + 1 < bh && blockLumaN[i + bw] > 0) {
        patchSum += Math.abs(cur - blockLuma[i + bw] / blockLumaN[i + bw]);
        patchN += 1;
      }
    }
  }
  const patchiness = patchN ? patchSum / patchN : 0;    // 0..255, lệch luma giữa ô kề

  // --- Bước 2: nhận diện HOA VĂN LẶP CHU KỲ (bàn cờ, gạch ca-rô, kẻ sọc) ---
  // Ý tưởng: hoa văn lặp thì có một khoảng cách L mà tại đó luma "khớp lại"
  // (lệch nhỏ hơn hẳn khoảng kề). Mảng mờ/loang lổ ngẫu nhiên thì không có
  // khoảng cách nào khớp. Quét nhiều độ trễ trên TỪNG TRỤC RIÊNG (hoa văn có
  // thể có chu kỳ ngang khác chu kỳ dọc — ví dụ bàn cờ ô 18x14 trong test).
  // Độ trễ tính bằng đơn vị Ô LƯỚI (mỗi ô = BLOCK = 3px).
  const LAG_CANDIDATES = [2, 3, 4, 5, 6, 7, 8, 10, 12, 14];
  let bestMatch = 0; // mức "khớp lại" tốt nhất tìm được (0..1)

  for (const lag of LAG_CANDIDATES) {
    // --- Trục ngang ---
    let hSum = 0;
    let hN = 0;
    for (let by = 0; by < bh; by += 1) {
      for (let bx = 0; bx + lag < bw; bx += 1) {
        const i = by * bw + bx;
        const j = i + lag;
        if (blockLumaN[i] === 0 || blockLumaN[j] === 0) continue;
        hSum += Math.abs(blockLuma[i] / blockLumaN[i] - blockLuma[j] / blockLumaN[j]);
        hN += 1;
      }
    }
    // --- Trục dọc ---
    let vSum = 0;
    let vN = 0;
    for (let by = 0; by + lag < bh; by += 1) {
      for (let bx = 0; bx < bw; bx += 1) {
        const i = by * bw + bx;
        const j = i + bw * lag;
        if (blockLumaN[i] === 0 || blockLumaN[j] === 0) continue;
        vSum += Math.abs(blockLuma[i] / blockLumaN[i] - blockLuma[j] / blockLumaN[j]);
        vN += 1;
      }
    }
    const hDev = hN ? hSum / hN : Infinity;
    const vDev = vN ? vSum / vN : Infinity;
    // Một trục khớp là đủ để kết luận có chu kỳ -> lấy trục khớp TỐT HƠN.
    const dev = Math.min(hDev, vDev);
    // Chỉ có ý nghĩa khi bề mặt THỰC SỰ lệch ở khoảng kề. Ảnh phẳng (patchiness
    // gần 0) thì mọi độ trễ đều "khớp" một cách vô nghĩa -> bỏ qua.
    if (Number.isFinite(dev) && patchiness >= 4) {
      const ratio = dev / patchiness;
      bestMatch = Math.max(bestMatch, clamp(1 - ratio, 0, 1));
    }
  }

  // periodicity: mức khớp lại tốt nhất khi dịch theo một chu kỳ nào đó.
  const periodicity = bestMatch;

  // Mật độ vùng tối bất thường (mảng mốc, vũng bẩn, đồ đạc sẫm màu chồng chất)
  // đã có ở darkRatio. Kết hợp thành "mức mảng mờ".
  //
  // LƯU Ý: patchiness cao KHÔNG luôn là bẩn — hoa văn tương phản cao (ô bàn cờ,
  // gạch lát ca-rô, kẻ sọc đậm) cũng cho ô kề nhau lệch mạnh. Ta chỉ tính phần
  // patchiness VƯỢT TRÊN mức mà kết cấu đã giải thích được:
  //   - texture cao + patchiness ở mức vừa  -> kết cấu, không tính là mảng mờ.
  //   - patchiness rất cao (vượt xa kết cấu) -> mới là loang lổ thật.
  //   - periodicity cao (hoa văn lặp chu kỳ) -> LÀ HOA VĂN, không phải mảng mờ.
  //     Đây là cổng bắt các trường hợp như gạch ca-rô, kẻ sọc, ô bàn cờ.
  const patchOverTexture = Math.max(0, patchiness - 30 * texture);
  const patternGate = 1 - smoothstep(periodicity, 0.55, 0.9);
  const mottle = clamp(
    (0.6 * smoothstep(patchOverTexture, 12, 60) + 0.4 * smoothstep(darkRatio, 5, 30))
      * patternGate,
    0, 1
  );

  // Độ "trải" histogram: ảnh càng nhiều mảng sáng/tối đan xen -> entropy cao
  let lumaEntropy = 0;
  for (let i = 0; i < 32; i += 1) {
    if (bins[i] === 0) continue;
    const pr = bins[i] / total;
    lumaEntropy -= pr * Math.log2(pr);
  }
  const lumaEntropyNorm = lumaEntropy / 5; // log2(32) = 5

  return {
    decoded: true,
    size,
    width,
    height,
    bytesPerPixel: size / total,
    byteEntropy: round1(byteEntropy),
    meanByte: round1(byteSum / size),
    lumaMean: round1(lumaMean),
    contrast: round1(contrast),
    darkRatio: round1(darkRatio * 100),
    grain: round1(grain),
    grainDensity: round1(grainDensity * 100),
    grainSpread: round1(grainSpread * 100),
    dustness: round1(dustness * 100),
    texture: round1(texture * 100),
    patchiness: round1(patchiness),
    periodicity: round1(periodicity * 100),
    mottle: round1(mottle * 100),
    saturation: round1(saturation),
    edgeRatio: round1(edgeRatio * 100),
    lumaEntropyNorm: round1(lumaEntropyNorm * 100),
    // giá trị thô để tính toán
    meanByteRaw: byteSum / size,
    byteEntropyRaw: byteEntropy
  };
}

// ------------------------------------------------------------
// Suy ra 5 chỉ số bẩn từ đặc trưng thô
// ------------------------------------------------------------
// Nguyên tắc: mỗi chỉ số = nền thấp (5) + biên độ * mức độ bất thường (0..1).
// Nền thấp nên phòng sạch cho điểm thấp; chỉ ảnh thực sự xấu mới lên cao.
function deriveSignals(features, seed) {
  const jitter = (stableHash(seed) - 0.5) * 6; // ±3 điểm, tránh trùng số máy móc

  // --- Nhánh dự phòng: ảnh không giải mã được -> chỉ dùng byte, dải hẹp ---
  if (!features.decoded) {
    const entNorm = smoothstep(features.byteEntropyRaw, 6.5, 8);
    const darkNorm = smoothstepInv(features.meanByteRaw, 90, 170);
    const base = 30 + entNorm * 25 + darkNorm * 20 + jitter;
    return {
      clutter:    clamp(base + 4),
      stains:     clamp(base + 2),
      dust:       clamp(base + 6),
      brightness: clamp(5 + darkNorm * 90 + jitter * 0.5),
      debris:     clamp(base + 5)
    };
  }

  const {
    lumaMean, contrast, darkRatio, grain, saturation, edgeRatio,
    lumaEntropyNorm, bytesPerPixel, dustness, texture, patchiness, mottle
  } = features;

  // 1) ĐỘ SÁNG: chỉ số này CHỈ tăng khi ảnh THỰC SỰ thiếu sáng.
  //    Phòng sáng (luma ~200) -> 0. Phòng rất tối (luma ~50) -> 1.
  const darknessNorm = smoothstepInv(lumaMean, 50, 150);

  // 2) VẾT BẨN: tương phản cục bộ cao + màu bão hoà lệch (ố vàng/nâu)
  //    + nhiều mảng tối bất thường (vũng bẩn, mốc).
  const contrastNorm = smoothstep(contrast, 8, 34);
  const saturationNorm = smoothstep(saturation, 15, 48);
  const darkNorm = smoothstep(darkRatio, 1, 15);
  const stainScore = 0.45 * contrastNorm + 0.3 * saturationNorm + 0.25 * darkNorm;

  // 3) BỤI BÁM & MẢNG MỜ: chỉ số này gồm HAI thành phần, đúng như tên gọi.
  //    a) Hạt mịn (bụi lấm tấm): grain, nhưng chỉ tính khi KHÔNG phải kết cấu.
  //    b) Mảng mờ/loang lổ (bụi phủ vệt, ố mờ diện rộng): mottle, đo quy mô lớn.
  //
  //    texture chỉ TRIỆT TIÊU thành phần hạt (a), không triệt tiêu thành phần
  //    mảng mờ (b) — vì mảng mờ loang lổ KHÔNG bao giờ là kết cấu hợp pháp.
  //    Chọn MAX của hai thành phần (không cộng dồn) để tránh dìm chỉ số xuống
  //    khi một trong hai thành phần không áp dụng được cho loại ảnh đó.
  const grainNorm = smoothstep(grain, 3, 22);
  const dustFactor = dustness / 100;                  // 0..1
  const grainPart = grainNorm * dustFactor;           // hạt mịn đã loại kết cấu
  const mottlePart = mottle;                          // mảng mờ, không bị texture chặn
  const dustScore = clamp(Math.max(grainPart, mottlePart * 1.15) * 0.85
                        + 0.15 * Math.min(grainPart, mottlePart), 0, 1);
  //    Ngưỡng đặt thấp vì ảnh thật hiếm khi vượt 15% pixel là cạnh mạnh.
  //    Trừ bớt phần do kết cấu bề mặt đều đặn gây ra (vân gỗ có cạnh nhưng không lộn xộn).
  const textureFactor = texture / 100;
  const clutterEdgeNorm = smoothstep(edgeRatio, 2, 14) * (1 - 0.5 * textureFactor);
  const clutterEntropyNorm = smoothstep(lumaEntropyNorm, 50, 88);
  const clutterScore = 0.6 * clutterEdgeNorm + 0.4 * clutterEntropyNorm;

  // 5) RÁC / MẢNH VỤN: hạt THÔ + thưa (dustness cao) kèm mảng tối nhỏ.
  //    Cũng bị chiết khấu bởi textureFactor để không nhầm vân gỗ thành rác.
  const debrisScore = (0.5 * smoothstep(grain, 5, 26)
                    + 0.3 * smoothstep(darkRatio, 1, 16)
                    + 0.2 * smoothstep(edgeRatio, 3, 18)) * (0.4 + 0.6 * dustFactor);

  // Ánh xạ 0..1 -> điểm 0..100 với nền thấp (5) và biên độ 90.
  const toScore = (norm) => clamp(5 + norm * 90 + jitter);

  return {
    clutter:    toScore(clutterScore),
    stains:     toScore(stainScore),
    dust:       toScore(dustScore),
    brightness: toScore(darknessNorm),
    debris:     toScore(debrisScore)
  };
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
  const seed = `${meta.filename || ''}:${features.size}:${features.lumaMean ?? features.meanByte}`;
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
      decoded: features.decoded,
      fileSizeBytes: features.size,
      width: features.width,
      height: features.height,
      // Đặc trưng pixel thật (null nếu ảnh không giải mã được)
      lumaMean: features.lumaMean,
      contrast: features.contrast,
      darkRatioPercent: features.darkRatio,
      grain: features.grain,
      grainDensityPercent: features.grainDensity,
      grainSpreadPercent: features.grainSpread,
      dustnessPercent: features.dustness,
      texturePercent: features.texture,
      patchiness: features.patchiness,
      periodicityPercent: features.periodicity,
      mottlePercent: features.mottle,
      saturation: features.saturation,
      edgeRatioPercent: features.edgeRatio,
      bytesPerPixel: features.bytesPerPixel ? round1(features.bytesPerPixel) : null,
      // Đặc trưng byte nén, giữ lại để tham chiếu
      byteEntropy: features.byteEntropy,
      meanByte: features.meanByte
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
