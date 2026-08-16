const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const http = require('http');
const https = require('https');

const app = express();

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  // يفضّل تغييره إلى true في الإنتاج بعد التأكد من شهادة المصدر.
  rejectUnauthorized: false,
});

/*
 * validateStatus مهم هنا حتى نستطيع تسجيل استجابة 404 أو 403 بأنفسنا،
 * بدلاً من أن يرمي Axios الخطأ قبل أن نعرف تفاصيل الاستجابة.
 */
const axiosInstance = axios.create({
  timeout: 15000,
  responseType: 'arraybuffer',
  httpAgent,
  httpsAgent,
  validateStatus: () => true,
});

class UpstreamError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'UpstreamError';
    this.upstreamStatus = status;
  }
}

function getErrorText(error) {
  return String(error?.message || error || 'Unknown Error');
}

/*
 * ألوان صورة الخطأ:
 * الأحمر = المصدر أعاد 404 أو Not Found
 * الأصفر = انتهت المهلة
 * البرتقالي = 403 أو منع من المصدر
 * الأزرق = المصدر أرسل HTML أو محتوى غير صورة
 * الأسود = خطأ عام أو خطأ في Sharp
 */
function getFallbackColor(error) {
  const message = getErrorText(error);
  const status = Number(
    error?.upstreamStatus || error?.response?.status || 0,
  );

  if (status === 404 || /\b404\b|not found/i.test(message)) {
    return '#FF4444';
  }

  if (status === 403 || /\b403\b|forbidden|cloudflare/i.test(message)) {
    return '#FF8C00';
  }

  if (/timeout|ETIMEDOUT|ECONNABORTED/i.test(message)) {
    return '#FFCC00';
  }

  if (/Content-Type|HTML|not an image|Invalid image|unsupported image/i.test(message)) {
    return '#00AAFF';
  }

  return '#111111';
}

async function getFallbackImage(error) {
  const bgColor = getFallbackColor(error);

  const svgText = `
    <svg width="600" height="400" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="${bgColor}"/>
    </svg>
  `;

  return sharp(Buffer.from(svgText))
    .jpeg({ quality: 80 })
    .toBuffer();
}

function normalizeMeshMangaImageUrl(imageUrl) {
  try {
    const sourceUrl = new URL(imageUrl);
    const host = sourceUrl.hostname.toLowerCase();

    /*
     * API الخاص بالموقع يعيد appswat.com، لكن Vercel يرى 404 عند طلب ملف
     * الوسائط المباشر من ذلك المسار. اختبرنا أن Next Image في MeshManga
     * يستطيع جلب الملف من داخل الموقع ويعيد 200، لذلك نستخدمه كوسيط.
     */
    if (
      (host === 'appswat.com' || host === 'meshmanga.com') &&
      sourceUrl.pathname.startsWith('/v2/media/')
    ) {
      sourceUrl.hostname = 'meshmanga.com';
      const directMeshUrl = sourceUrl.toString();

      return `https://meshmanga.com/_next/image?url=${encodeURIComponent(
        directMeshUrl,
      )}&w=1920&q=75`;
    }
  } catch (_) {
    // سيتم التعامل مع الرابط غير الصالح في مرحلة التحقق الرئيسية.
  }

  return imageUrl;
}

function getQuality(req) {
  const rawQuality =
    req.query.q ||
    req.query.quality ||
    req.query.l ||
    req.headers['x-image-quality'];

  let quality = 40;

  if (rawQuality !== undefined && rawQuality !== null && rawQuality !== '') {
    quality = Number.parseInt(rawQuality, 10);

    if (Number.isNaN(quality)) {
      quality = 40;
    }

    // الحفاظ على السلوك الموجود في الكود الأصلي.
    if (quality === 40) {
      quality = 30;
    }

    quality = Math.max(1, Math.min(100, quality));
  }

  return quality;
}

app.get('/', async (req, res) => {
  const imageUrl = req.query.url;

  if (!imageUrl) {
    return res.status(200).send('v2.8-SmartProxy-Debuggable');
  }

  if (typeof imageUrl !== 'string') {
    const error = new Error('Invalid url parameter');
    const fallbackBuffer = await getFallbackImage(error);

    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': fallbackBuffer.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Proxy-Status': 'Invalid-URL',
    });

    return res.status(200).send(fallbackBuffer);
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(imageUrl);

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Only HTTP and HTTPS URLs are allowed');
    }
  } catch (error) {
    console.error('Invalid image URL:', {
      imageUrl,
      message: error.message,
    });

    const fallbackBuffer = await getFallbackImage(error);

    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': fallbackBuffer.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Proxy-Status': 'Invalid-URL',
    });

    return res.status(200).send(fallbackBuffer);
  }

  const upstreamImageUrl = normalizeMeshMangaImageUrl(imageUrl);

  try {
    const domainOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;

    /*
     * نرسل أقل عدد ممكن من الرؤوس حتى يكون الطلب قريباً من الطلب المباشر.
     * لا نرسل Origin أو Sec-Fetch-* يدوياً؛ هذه رؤوس متصفح وقد تغيّر رد المصدر.
     */
    const requestHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      Accept:
        'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
    };

    /* استخدم Referer فقط إذا كان مطلوباً من المصدر. */
    const upstreamReferer =
      typeof req.query.referer === 'string'
        ? req.query.referer
        : process.env.UPSTREAM_REFERER;

    if (upstreamReferer) {
      requestHeaders.Referer = upstreamReferer;
    }

    /* لا تمرر Cookie إلا عند تفعيله صراحةً. */
    if (process.env.FORWARD_UPSTREAM_COOKIE === 'true' && req.headers.cookie) {
      requestHeaders.Cookie = req.headers.cookie;
    }

    // هذا يطبع الرابط الذي يستلمه البروكسي فعلياً.
    console.log('IMAGE REQUEST TO PROXY:', {
      requestedUrl: imageUrl,
      upstreamUrl: upstreamImageUrl,
    });

    const response = await axiosInstance.get(upstreamImageUrl, {
      headers: requestHeaders,
    });

    const contentType = String(response.headers['content-type'] || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();

    const responseBuffer = Buffer.isBuffer(response.data)
      ? response.data
      : Buffer.from(response.data || '');

    const finalUrl = response.request?.res?.responseUrl || upstreamImageUrl;

    console.log('UPSTREAM IMAGE RESPONSE:', {
      requestedUrl: imageUrl,
      upstreamUrl: upstreamImageUrl,
      finalUrl,
      status: response.status,
      contentType,
      bytes: responseBuffer.length,
      location: response.headers.location || '',
      server: response.headers.server || '',
    });

    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamError(
        `Upstream HTTP ${response.status} (${response.statusText || 'request failed'})`,
        response.status,
      );
    }

    if (responseBuffer.length === 0) {
      throw new UpstreamError('Invalid image: empty response', response.status);
    }

    if (contentType.includes('text/html')) {
      throw new UpstreamError(
        `Invalid Content-Type: ${contentType}`,
        response.status,
      );
    }

    /*
     * نتأكد من أن البيانات صورة حقيقية قبل الضغط.
     * هذا يميز بين صورة سليمة وبين HTML/JSON أعاده المصدر مع status 200.
     */
    let metadata;

    try {
      metadata = await sharp(responseBuffer, {
        failOn: 'none',
      }).metadata();
    } catch (error) {
      throw new UpstreamError(
        `Invalid image payload: ${error.message}`,
        response.status,
      );
    }

    if (!metadata.format) {
      throw new UpstreamError(
        `Invalid image format; Content-Type=${contentType || 'missing'}`,
        response.status,
      );
    }

    const fileSizeInKB = responseBuffer.length / 1024;
    const quality = getQuality(req);
    const dynamicThresholdKB = 680 + (quality - 10) * 8;

    const isGrayscale =
      req.query.bw === '1' ||
      req.query.bw === 'true' ||
      req.query.grayscale === '1';

    let pipeline = sharp(responseBuffer, {
      failOn: 'none',
      fastShrinkOnLoad: true,
    }).rotate();

    if (fileSizeInKB > dynamicThresholdKB) {
      const targetWidth = Math.round(500 + (quality / 100) * 1000);

      pipeline = pipeline.resize({
        width: targetWidth,
        fit: 'inside',
        withoutEnlargement: true,
        fastShrinkOnLoad: true,
      });
    }

    if (isGrayscale) {
      pipeline = pipeline.grayscale();
    }

    const compressedBuffer = await pipeline
      .jpeg({
        quality,
        mozjpeg: true,
        progressive: true,
        chromaSubsampling: quality < 50 ? '4:2:0' : '4:4:4',
        trellisQuantisation: true,
        overshootDeringing: true,
      })
      .toBuffer();

    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': compressedBuffer.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Proxy-Version': '2.8-Debuggable',
      'X-Proxy-Debug': `OK|format=${metadata.format}|sourceBytes=${responseBuffer.length}`,
      'X-Source-Format': metadata.format,
    });

    return res.status(200).send(compressedBuffer);
  } catch (error) {
    const errorStatus =
      error.upstreamStatus || error.response?.status || 0;

    const errorMessage = error.message || 'Fetch Failed';

    /*
     * وضع التشخيص للجوال:
     * افتح نفس رابط البروكسي مع إضافة &debug=1.
     * بدلاً من صورة fallback سيظهر JSON يمكن نسخه من المتصفح.
     */
    if (req.query.debug === '1' || req.query.debug === 'true') {
      return res.status(502).json({
        proxyVersion: '2.8-Debuggable',
        requestedUrl: imageUrl,
        upstreamUrl: upstreamImageUrl,
        status: errorStatus,
        code: error.code || null,
        message: errorMessage,
        upstreamContentType: error.response?.headers?.['content-type'] || null,
      });
    }

    console.error('IMAGE PROXY ERROR:', {
      imageUrl,
      upstreamUrl: upstreamImageUrl,
      status: errorStatus,
      code: error.code || '',
      message: errorMessage,
      upstreamContentType: error.response?.headers?.['content-type'] || '',
    });

    try {
      const fallbackBuffer = await getFallbackImage(error);

      res.set({
        'Content-Type': 'image/jpeg',
        'Content-Length': fallbackBuffer.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Proxy-Version': '2.8-Debuggable',
        'X-Proxy-Status': 'Error-Report',
        'X-Proxy-Debug': `ERROR|status=${errorStatus}|message=${encodeURIComponent(errorMessage.slice(0, 140))}`,
        'X-Proxy-Error': encodeURIComponent(errorMessage.slice(0, 180)),
      });

      // تبقى 200 حتى يعرض العميل صورة الحالة الملونة بدلاً من كسر عنصر الصورة.
      return res.status(200).send(fallbackBuffer);
    } catch (fallbackError) {
      console.error('FALLBACK GENERATION ERROR:', fallbackError);
      return res.status(500).send('Critical Error');
    }
  }
});

module.exports = app;
