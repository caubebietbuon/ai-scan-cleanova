// ============================================================
// CLEANOVA AI MODULE - External Analyzer (tuỳ chọn)
// ============================================================
// Cho phép cắm một service AI thật (Python/FastAPI, TensorFlow Serving,
// endpoint cloud, ...) mà không phải sửa phần còn lại của module.
//
// Bật bằng cách đặt trong `.env`:
//   ANALYZER=external
//   AI_SERVICE_URL=http://localhost:9000/predict
//   AI_SERVICE_KEY=...   (nếu service cần xác thực)
//
// Service bên ngoài phải nhận multipart/form-data với field `image`
// và trả JSON theo đúng cấu trúc:
//   {
//     "overallScore": 72.5,
//     "signals": { "clutter":.., "stains":.., "dust":.., "brightness":.., "debris":.. },
//     "findings": [ { "id":.., "label":.., "score":.., "severity":"low|medium|high" } ]
//   }
// ============================================================

async function analyzeWithExternalService(buffer, meta = {}) {
  const url = process.env.AI_SERVICE_URL;
  if (!url) {
    console.warn('[External Analyzer] Thiếu AI_SERVICE_URL, bỏ qua.');
    return null;
  }

  try {
    const form = new FormData();
    const blob = new Blob([buffer], { type: meta.mimetype || 'image/jpeg' });
    form.append('image', blob, meta.filename || 'room.jpg');

    const headers = {};
    if (process.env.AI_SERVICE_KEY) {
      headers['Authorization'] = `Bearer ${process.env.AI_SERVICE_KEY}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[External Analyzer] HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    if (typeof data.overallScore !== 'number' || !data.signals) {
      console.warn('[External Analyzer] Phản hồi sai định dạng.');
      return null;
    }

    return {
      analyzer: 'external',
      overallScore: data.overallScore,
      signals: data.signals,
      findings: data.findings || [],
      features: data.features || null
    };
  } catch (err) {
    console.warn('[External Analyzer] Lỗi gọi service:', err.message);
    return null;
  }
}

module.exports = { analyzeWithExternalService };
