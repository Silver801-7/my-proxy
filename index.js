const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const http = require('http');
const https = require('https');

const app = express();

// ============================================================================
// ⚙️ إعدادات الدقة المخصصة لتوفير الباقة (عدّل الأرقام على اليمين كما تحب)
// اليسار = الرقم الذي تختاره في التطبيق | اليمين = الدقة الفعلية التي ينفذها السيرفر
// ============================================================================
const QUALITY_MAP = {
  10: 10,  // 10% في التطبيق -> 10% في السيرفر
  20: 15,  // 20% في التطبيق -> 15% في السيرفر (توفير مضاعف للباقة)
  40: 30,  // 40% في التطبيق -> 30% في السيرفر
  50: 40,  // 50% في التطبيق -> 40% في السيرفر
  70: 55,  // 70% في التطبيق -> 55% في السيرفر
  80: 65,  // 80% في التطبيق -> 65% في السيرفر
  90: 75,  // 90% في التطبيق -> 75% في السيرفر
  95: 45,  // 95% في التطبيق -> 45% مع إجبار الضغط لكل الصور
};

const DEFAULT_QUALITY = 30;
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
  timeout: 14000,
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
 * إرجاع رسالة نصية لا تستهلك أي باقة (أقل من 50 بايت) في حال فشل الصورة
 */
function getErrorCodeInfo(error) {
  const message = getErrorText(error);
  const status = Number(error?.upstreamStatus || error?.response?.status || 0);

  if (status === 404 || /\b404\b|not found/i.test(message)) {
    return { httpStatus: 404, code: 'ERR_404_NOT_FOUND' };
  }
  if (status === 403 || /\b403\b|forbidden|cloudflare/i.test(message)) {
    return { httpStatus: 403, code: 'ERR_403_FORBIDDEN' };
  }
  if (/timeout|ETIMEDOUT|ECONNABORTED/i.test(message)) {
    return { httpStatus: 504, code: 'ERR_504_TIMEOUT' };
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
  });

  if (extraDebug) {
    res.set('X-Proxy-Debug', extraDebug);
  }

  return res.status(info.httpStatus).send(`${info.code}: ${rawMessage}`);
}

/*
 * بناء روابط بديلة تتخطى حماية Cloudflare وتسحب الصورة إلى سيرفرك ليتم ضغطها
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

      // الرابط المعالج لعلامات التنصيص الخاصة بـ meshmanga
      const doubleEncodedPath = sourceUrl.pathname.replace(
        /%(?!25)([0-9a-f]{2})/gi,
        '%25$1',
      );
      const repairedDirectUrl = `https://meshmanga.com${doubleEncodedPath}`
        .replace(/%25e2%80%99/gi, '%25e2%2580%2599')
        .replace(/%e2%80%99/gi, '%25e2%2580%2599');

      const nextImg1920 = `https://meshmanga.com/_next/image?url=${encodeURIComponent(repairedDirectUrl)}&w=1920&q=75`;
      const nextImgClean = `https://meshmanga.com/_next/image?url=${encodeURIComponent(cleanTargetUrl)}&w=1920&q=75`;

      // 1. إذا كان لديك Cloudflare Worker خاص بك
      if (process.env.CF_WORKER_URL) {
        const baseWorker = process.env.CF_WORKER_URL.replace(/\/$/, '');
        add(`${baseWorker}/?url=${encodeURIComponent(cleanTargetUrl)}`);
        add(`${baseWorker}/?url=${encodeURIComponent(nextImg1920)}`);
      }

      // 2. سحب الصورة عبر وسطاء الصور المفتوحة لتجاوز حظر IP Vercel
      add(`https://wsrv.nl/?url=${encodeURIComponent(cleanTargetUrl)}`);
      add(`https://wsrv.nl/?url=${encodeURIComponent(nextImg1920)}`);
      add(`https://wsrv.nl/?url=${encodeURIComponent(nextImgClean)}`);
      add(`https://i0.wp.com/meshmanga.com${sourceUrl.pathname}`);
      add(`https://cdn.statically.io/img/meshmanga.com${sourceUrl.pathname}`);

      // 3. المحاولة المباشرة من Vercel
      add(nextImg1920);
      add(cleanTargetUrl);
      add(repairedDirectUrl);

      return candidates;
    }
  } catch (_) {}

  if (process.env.CF_WORKER_URL) {
    const baseWorker = process.env.CF_WORKER_URL.replace(/\/$/, '');
    add(`${baseWorker}/?url=${encodeURIComponent(cleanTargetUrl)}`);
  }

  add(`https://wsrv.nl/?url=${encodeURIComponent(cleanTargetUrl)}`);

  try {
    const parsed = new URL(cleanTargetUrl);
    if (parsed.protocol === 'https:') {
      add(`https://i0.wp.com/${parsed.host}${parsed.pathname}${parsed.search}`);
      add(`https://cdn.statically.io/img/${parsed.host}${parsed.pathname}`);
    }
  } catch (_) {}

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

  if (Object.prototype.hasOwnProperty.call(QUALITY_MAP, parsed)) {
    return Math.max(1, Math.min(100, QUALITY_MAP[parsed]));
  }

  return Math.max(1, Math.min(100, parsed));
}

app.get('/', async (req, res) => {
  const imageUrl = req.query.url;

  if (!imageUrl) {
    return res.status(200).send('v3.1-StrictDataSaver-Active');
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
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      Accept:
        'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
    };

    if (req.headers.cookie) {
      baseHeaders.Cookie = req.headers.cookie;
    }

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
            `HTTP ${candidateResponse.status}`,
            candidateResponse.status,
          );
        }

        if (candidateBuffer.length === 0 || candidateContentType.includes('text/html')) {
          throw new UpstreamError('Invalid payload', candidateResponse.status);
        }

        const candidateMetadata = await sharp(candidateBuffer, {
          failOn: 'none',
          limitInputPixels: false,
        }).metadata();

        if (!candidateMetadata.format) {
          throw new UpstreamError('Not an image', candidateResponse.status);
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
      });
      return res.status(200).send(forcedBuffer);
    }

    if (!shouldResize && !isGrayscale) {
      res.set({
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': responseBuffer.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
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
    });

    return res.status(200).send(compressedBuffer);
  } catch (error) {
    // في حال الفشل التام: نرجع خطأ نصي خفيف (بضع بايتات فقط) ولا نسمح بتحميل الصورة الأصلية أبداً لحماية الباقة
    const errorStatus = error.upstreamStatus || error.response?.status || 0;
    const errorMessage = error.message || 'Fetch Failed';
    const debugHeader = `ERROR|attempts=${attemptedUpstreams.length}|status=${errorStatus}|msg=${encodeURIComponent(errorMessage.slice(0, 140))}`;
    return sendTextError(res, error, debugHeader);
  }
});

module.exports = app;
