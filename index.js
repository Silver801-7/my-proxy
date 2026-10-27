const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const http = require('http');
const https = require('https');

const app = express();

// ============================================================================
// ⚙️ إعدادات الدقة المخصصة (عدل الأرقام التي على اليمين كما تريد)
// الرقم الذي على اليسار هو الموجود في التطبيق، واليمين هو الدقة الفعلية التي سينفذها السيرفر
// ============================================================================
const QUALITY_MAP = {
  10: 10,  // إذا اخترت 10% في التطبيق -> السيرفر يجعلها 10%
  20: 15,  // إذا اخترت 20% في التطبيق -> السيرفر يجعلها 15% (كما طلبت)
  40: 35,  // إذا اخترت 40% في التطبيق -> السيرفر يجعلها 35%
  50: 45,  // إذا اخترت 50% في التطبيق -> السيرفر يجعلها 45%
  70: 60,  // إذا اخترت 70% في التطبيق -> السيرفر يجعلها 60%
  80: 70,  // إذا اخترت 80% في التطبيق -> السيرفر يجعلها 70%
  90: 80,  // إذا اخترت 90% في التطبيق -> السيرفر يجعلها 80%
  95: 45,  // إذا اخترت 95% في التطبيق -> السيرفر يجعلها 45% (مع إجبار الضغط)
};

// الدقة الافتراضية في حال لم يرسل التطبيق أي رقم
const DEFAULT_QUALITY = 35;

// خيار إجبار الضغط: ضع الرقم من التطبيق الذي تريد عند اختياره أن يضغط كل الصور إجبارياً
const FORCE_COMPRESSION_TRIGGER = 95;
// ============================================================================


const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  rejectUnauthorized: false,
  ciphers: [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384',
  ].join(':'),
  honorCipherOrder: true,
  minVersion: 'TLSv1.2',
});

const axiosInstance = axios.create({
  timeout: 12000,
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

function getErrorCodeInfo(error) {
  const message = getErrorText(error);
  const status = Number(
    error?.upstreamStatus || error?.response?.status || 0,
  );

  if (status === 404 || /\b404\b|not found/i.test(message)) {
    return { httpStatus: 404, code: 'ERR_404_NOT_FOUND' };
  }

  if (status === 403 || /\b403\b|forbidden|cloudflare/i.test(message)) {
    return { httpStatus: 403, code: 'ERR_403_FORBIDDEN' };
  }

  if (/timeout|ETIMEDOUT|ECONNABORTED/i.test(message)) {
    return { httpStatus: 504, code: 'ERR_504_TIMEOUT' };
  }

  if (/Content-Type|HTML|not an image|Invalid image|unsupported image/i.test(message)) {
    return { httpStatus: 415, code: 'ERR_415_NOT_IMAGE' };
  }

  return {
    httpStatus: status >= 400 ? status : 502,
    code: 'ERR_502_GENERAL_ERROR',
  };
}

function sendTextError(res, error, extraDebug = '') {
  const info = getErrorCodeInfo(error);
  const rawMessage = getErrorText(error);

  res.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-Proxy-Status': info.code,
    'X-Proxy-Error': encodeURIComponent(rawMessage.slice(0, 180)),
  });

  if (extraDebug) {
    res.set('X-Proxy-Debug', extraDebug);
  }

  return res.status(info.httpStatus).send(`${info.code}: ${rawMessage}`);
}

/*
 * دالة توليد الروابط البديلة لتخطي حماية Cloudflare تلقائياً بدون تدخل منك
 */
function buildCandidateImageUrls(imageUrl) {
  const candidates = [];
  const add = (value) => {
    if (typeof value === 'string' && value && !candidates.includes(value)) {
      candidates.push(value);
    }
  };

  let cleanTargetUrl = imageUrl;

  try {
    const sourceUrl = new URL(imageUrl);
    const host = sourceUrl.hostname.toLowerCase();

    if (
      (host === 'appswat.com' || host === 'meshmanga.com') &&
      sourceUrl.pathname.startsWith('/v2/media/')
    ) {
      sourceUrl.hostname = 'meshmanga.com';
      cleanTargetUrl = sourceUrl.toString();

      // تصليح علامات الاقتباس الخاصة بموقع meshmanga
      const repairedDirectUrl = cleanTargetUrl
        .replace(/%25e2%80%99/gi, '%25e2%2580%2599')
        .replace(/%e2%80%99/gi, '%25e2%2580%2599');

      // 1. استخدام وسطاء عالميين لتمرير رابط _next/image أو الرابط المباشر لتخطي حظر IP Vercel
      const nextImg = `https://meshmanga.com/_next/image?url=${encodeURIComponent(repairedDirectUrl)}&w=1920&q=85`;
      
      add(`https://wsrv.nl/?url=${encodeURIComponent(cleanTargetUrl)}&default=1`);
      add(`https://wsrv.nl/?url=${encodeURIComponent(nextImg)}&default=1`);
      add(`https://i0.wp.com/${sourceUrl.host}${sourceUrl.pathname}`);
      add(`https://cdn.statically.io/img/${sourceUrl.host}${sourceUrl.pathname}`);
      add(nextImg);
      add(repairedDirectUrl);
      return candidates;
    }
  } catch (_) {}

  // لأي موقع آخر غير meshmanga:
  // المحاولة الأولى عبر وسيط wsrv لتخطي Cloudflare
  add(`https://wsrv.nl/?url=${encodeURIComponent(cleanTargetUrl)}&default=1`);

  // المحاولة الثانية عبر وسيط Jetpack (WordPress CDN)
  try {
    const parsed = new URL(cleanTargetUrl);
    if (parsed.protocol === 'https:') {
      add(`https://i0.wp.com/${parsed.host}${parsed.pathname}${parsed.search}`);
      add(`https://cdn.statically.io/img/${parsed.host}${parsed.pathname}`);
    }
  } catch (_) {}

  // المحاولة الأخيرة عبر الرابط المباشر
  add(cleanTargetUrl);

  return candidates;
}

async function makeGrayscaleWithoutResize(buffer, format) {
  const pipeline = sharp(buffer, { failOn: 'none', limitInputPixels: false }).grayscale();

  switch (String(format || '').toLowerCase()) {
    case 'png':
      return { buffer: await pipeline.png().toBuffer(), contentType: 'image/png' };
    case 'webp':
      return {
        buffer: await pipeline.webp({ lossless: true }).toBuffer(),
        contentType: 'image/webp',
      };
    case 'tiff':
      return {
        buffer: await pipeline.tiff({ compression: 'lzw' }).toBuffer(),
        contentType: 'image/tiff',
      };
    case 'jpeg':
    case 'jpg':
      return {
        buffer: await pipeline
          .jpeg({ quality: 100, chromaSubsampling: '4:4:4', progressive: true })
          .toBuffer(),
        contentType: 'image/jpeg',
      };
    default:
      return { buffer: await pipeline.png().toBuffer(), contentType: 'image/png' };
  }
}

function getRequestedQuality(req) {
  return (
    req.query.q ||
    req.query.quality ||
    req.query.l ||
    req.headers['x-image-quality']
  );
}

function isForcedCompression(req) {
  const rawQuality = getRequestedQuality(req);
  return Number.parseInt(rawQuality, 10) === FORCE_COMPRESSION_TRIGGER;
}

function getQuality(req) {
  const rawQuality = getRequestedQuality(req);

  if (rawQuality === undefined || rawQuality === null || rawQuality === '') {
    return DEFAULT_QUALITY;
  }

  const parsed = Number.parseInt(rawQuality, 10);

  if (Number.isNaN(parsed)) {
    return DEFAULT_QUALITY;
  }

  // إذا كانت القيمة موجودة في جدول QUALITY_MAP في أعلى الكود، نأخذ القيمة التي حددتها أنت
  if (Object.prototype.hasOwnProperty.call(QUALITY_MAP, parsed)) {
    return Math.max(1, Math.min(100, QUALITY_MAP[parsed]));
  }

  return Math.max(1, Math.min(100, parsed));
}

app.get('/', async (req, res) => {
  const imageUrl = req.query.url;

  if (!imageUrl) {
    return res.status(200).send('v3.0-CustomQualityMap-CloudflareBypass');
  }

  if (typeof imageUrl !== 'string') {
    return sendTextError(res, new Error('Invalid url parameter'));
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(imageUrl);

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Only HTTP and HTTPS URLs are allowed');
    }
  } catch (error) {
    return sendTextError(res, error);
  }

  let upstreamImageUrl = imageUrl;
  let attemptedUpstreams = [];

  try {
    const defaultReferer = `${parsedUrl.protocol}//${parsedUrl.hostname}/`;
    const upstreamReferer =
      typeof req.query.referer === 'string'
        ? req.query.referer
        : process.env.UPSTREAM_REFERER || defaultReferer;

    const baseHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept:
        'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
      'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
    };

    const candidateUrls = buildCandidateImageUrls(imageUrl);
    attemptedUpstreams = candidateUrls;

    let response = null;
    let responseBuffer = null;
    let contentType = '';
    let metadata = null;
    let lastCandidateError = null;

    for (const candidateUrl of candidateUrls) {
      upstreamImageUrl = candidateUrl;

      try {
        // إذا كان الرابط يمر عبر وسيط مجاني، لا نرسل Referer الموقع الأصلي حتى لا يرفضه الوسيط
        const isProxyService = /wsrv\.nl|wp\.com|statically\.io/i.test(candidateUrl);
        const currentHeaders = { ...baseHeaders };
        if (!isProxyService) {
          currentHeaders.Referer = upstreamReferer;
        }

        const candidateResponse = await axiosInstance.get(candidateUrl, {
          headers: currentHeaders,
        });

        const candidateContentType = String(
          candidateResponse.headers['content-type'] || '',
        )
          .split(';', 1)[0]
          .trim()
          .toLowerCase();

        const candidateBuffer = Buffer.isBuffer(candidateResponse.data)
          ? candidateResponse.data
          : Buffer.from(candidateResponse.data || '');

        if (candidateResponse.status < 200 || candidateResponse.status >= 300) {
          throw new UpstreamError(
            `Upstream HTTP ${candidateResponse.status}`,
            candidateResponse.status,
          );
        }

        if (candidateBuffer.length === 0) {
          throw new UpstreamError('Empty image buffer', candidateResponse.status);
        }

        if (candidateContentType.includes('text/html')) {
          throw new UpstreamError(
            `Invalid Content-Type: ${candidateContentType}`,
            candidateResponse.status,
          );
        }

        const candidateMetadata = await sharp(candidateBuffer, {
          failOn: 'none',
          limitInputPixels: false,
        }).metadata();

        if (!candidateMetadata.format) {
          throw new UpstreamError('Invalid image format', candidateResponse.status);
        }

        response = candidateResponse;
        responseBuffer = candidateBuffer;
        contentType = candidateContentType;
        metadata = candidateMetadata;
        break;
      } catch (candidateError) {
        lastCandidateError = candidateError;
      }
    }

    if (!response || !responseBuffer || !metadata) {
      throw lastCandidateError || new UpstreamError('All image candidates failed');
    }

    const width = metadata.width || 800;
    const height = metadata.height || 1200;
    const fileSizeInKB = responseBuffer.length / 1024;
    const quality = getQuality(req);

    const dynamicThresholdKB = 100 + (quality - 10) * 5;
    const isLongStrip = height / width >= 3.0 || height > 3500;
    const stripFactor = isLongStrip ? Math.min(2.5, 1 + (height - 2000) / 6000) : 1;
    const effectiveThresholdKB = dynamicThresholdKB * stripFactor;

    const isGrayscale =
      req.query.bw === '1' ||
      req.query.bw === 'true' ||
      req.query.grayscale === '1';

    const forceCompression = isForcedCompression(req);
    const shouldResize = fileSizeInKB > effectiveThresholdKB;

    if (forceCompression) {
      const forcedBuffer = await sharp(responseBuffer, {
        failOn: 'none',
        limitInputPixels: false,
        fastShrinkOnLoad: !isLongStrip,
      })
        .rotate()
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
        'Content-Length': forcedBuffer.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Proxy-Debug': `FORCED|quality=${quality}|outBytes=${forcedBuffer.length}`,
      });

      return res.status(200).send(forcedBuffer);
    }

    if (!shouldResize && !isGrayscale) {
      res.set({
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': responseBuffer.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Proxy-Debug': `ORIGINAL|bytes=${responseBuffer.length}`,
      });
      return res.status(200).send(responseBuffer);
    }

    if (!shouldResize && isGrayscale) {
      const gray = await makeGrayscaleWithoutResize(responseBuffer, metadata.format);
      res.set({
        'Content-Type': gray.contentType,
        'Content-Length': gray.buffer.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      return res.status(200).send(gray.buffer);
    }

    let pipeline = sharp(responseBuffer, {
      failOn: 'none',
      limitInputPixels: false,
      fastShrinkOnLoad: !isLongStrip,
    }).rotate();

    const baseTargetWidth = Math.round(390 + (quality / 100) * 900);
    const targetWidth =
      height > 5000
        ? Math.max(baseTargetWidth, Math.min(width, 780))
        : baseTargetWidth;

    pipeline = pipeline.resize({
      width: targetWidth,
      fit: 'inside',
      withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3,
      fastShrinkOnLoad: !isLongStrip,
    });

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

    if (!isGrayscale && compressedBuffer.length >= responseBuffer.length) {
      res.set({
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': responseBuffer.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      return res.status(200).send(responseBuffer);
    }

    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': compressedBuffer.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Proxy-Debug': `RESIZED|quality=${quality}|outBytes=${compressedBuffer.length}`,
    });

    return res.status(200).send(compressedBuffer);
  } catch (error) {
    const errorStatus = error.upstreamStatus || error.response?.status || 0;
    const errorMessage = error.message || 'Fetch Failed';
    const debugHeader = `ERROR|attempts=${attemptedUpstreams.length}|status=${errorStatus}|msg=${encodeURIComponent(errorMessage.slice(0, 140))}`;
    return sendTextError(res, error, debugHeader);
  }
});

module.exports = app;
