const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const http = require('http');
const https = require('https');

sharp.cache(false);
sharp.concurrency(2);

const app = express();

// ============================================================================
// ⚙️ إعدادات الدقة المخصصة لتوفير الباقة (عدّل الأرقام على اليمين كما تحب)
// اليسار = الرقم الذي تختاره في التطبيق | اليمين = الدقة الفعلية التي ينفذها السيرفر
// ============================================================================
const QUALITY_MAP = {
  10: 10,  // 10% في التطبيق -> 10% في السيرفر
  20: 15,  // 20% في التطبيق -> 15% في السيرفر
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

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
  rejectUnauthorized: false,
});

const axiosInstance = axios.create({
  timeout: 6000,
  responseType: 'arraybuffer',
  httpAgent,
  httpsAgent,
  validateStatus: () => true,
});

class UpstreamError extends Error {
  constructor(message, status = 0, details = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.upstreamStatus = status;
    this.details = details;
  }
}

function getErrorText(error) {
  return String(error?.message || error || 'Unknown Error');
}

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
 * تمرير العرض المطلوب للوسطاء لسحب الصورة بحجم خفيف وسريع جداً بدلاً من سحبها بحجم 5 ميغا
 */
function buildCandidateImageUrls(imageUrl, hintWidth = 800) {
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

      const doubleEncodedPath = sourceUrl.pathname.replace(
        /%(?!25)([0-9a-f]{2})/gi,
        '%25$1',
      );
      const repairedDirectUrl = `https://meshmanga.com${doubleEncodedPath}`
        .replace(/%25e2%80%99/gi, '%25e2%2580%2599')
        .replace(/%e2%80%99/gi, '%25e2%2580%2599');

      // نطلب عرض 1080 بدلاً من 1920 لتسريع استجابة موقع سوات مانجا للضعف
      const nextImg = `https://meshmanga.com/_next/image?url=${encodeURIComponent(repairedDirectUrl)}&w=1080&q=75`;

      // نجعل wsrv يصغر العرض مسبقاً لتصل الصورة إلى Vercel في لمح البصر
      add(`https://wsrv.nl/?url=${encodeURIComponent(cleanTargetUrl)}&w=${hintWidth}&we`);
      add(`https://images1-focus-opensocial.googleusercontent.com/gadgets/proxy?container=focus&refresh=2592000& resize_w=${hintWidth}&url=${encodeURIComponent(cleanTargetUrl)}`);
      add(`https://images1-focus-opensocial.googleusercontent.com/gadgets/proxy?container=focus&refresh=2592000&url=${encodeURIComponent(nextImg)}`);
      add(`https://wsrv.nl/?url=${encodeURIComponent(nextImg)}&w=${hintWidth}&we`);
      add(`https://i0.wp.com/meshmanga.com${sourceUrl.pathname}?w=${hintWidth}`);
      add(`https://appswat.com${sourceUrl.pathname}`);
      add(nextImg);
      add(cleanTargetUrl);

      return candidates;
    }
  } catch (_) {}

  add(`https://wsrv.nl/?url=${encodeURIComponent(cleanTargetUrl)}&w=${hintWidth}&we`);
  add(`https://images1-focus-opensocial.googleusercontent.com/gadgets/proxy?container=focus&refresh=2592000&url=${encodeURIComponent(cleanTargetUrl)}`);

  try {
    const parsed = new URL(cleanTargetUrl);
    if (parsed.protocol === 'https:') {
      add(`https://i0.wp.com/${parsed.host}${parsed.pathname}?w=${hintWidth}`);
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
        buffer: await pipeline.webp({ quality: 80 }).toBuffer(),
        contentType: 'image/webp',
      };
    case 'jpeg':
    case 'jpg':
      return {
        buffer: await pipeline
          .jpeg({ quality: 85, chromaSubsampling: '4:2:0' })
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

async function fetchValidImage(candidateUrl, baseHeaders, upstreamReferer, signal) {
  const isProxyService = /googleusercontent\.com|wsrv\.nl|wp\.com/i.test(candidateUrl);
  const currentHeaders = { ...baseHeaders };

  if (!isProxyService) {
    currentHeaders.Referer = upstreamReferer;
    currentHeaders.Origin = upstreamReferer.replace(/\/$/, '');
  }

  try {
    const res = await axiosInstance.get(candidateUrl, {
      headers: currentHeaders,
      signal,
    });

    const contentType = String(res.headers['content-type'] || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();

    const buffer = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data || '');

    if (res.status < 200 || res.status >= 300) {
      throw new UpstreamError(`HTTP ${res.status}`, res.status, {
        candidateUrl,
        status: res.status,
      });
    }

    if (buffer.length < 150 || contentType.includes('text/html') || contentType.includes('application/json')) {
      throw new UpstreamError('Invalid payload', res.status, {
        candidateUrl,
        status: res.status,
      });
    }

    return { buffer, contentType, candidateUrl };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError(err.message || 'Network Error', 0, {
      candidateUrl,
      message: err.message,
    });
  }
}

app.get('/', async (req, res) => {
  const startTotalTime = Date.now();
  let imageUrl = req.query.url;
  if (typeof imageUrl === 'string' && req.query.v && !imageUrl.includes('?v=')) {
    imageUrl = `${imageUrl}?v=${req.query.v}`;
  }

  const isDebugMode = req.query.debug === '1' || req.query.debug === 'true';

  if (!imageUrl) {
    return res.status(200).send('v4.8-UltraFast-SpeedTest-Ready');
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

  const quality = getQuality(req);
  const baseTargetWidth = Math.round(390 + (quality / 100) * 900);
  // نطلب عرضاً مبدئياً (مثلاً 780 بكسل) من الوسيط لتسريع النقل الداخلي 10 أضعاف
  const preFetchWidth = Math.max(baseTargetWidth, 780);

  const candidateUrls = buildCandidateImageUrls(imageUrl, preFetchWidth);
  const controllers = candidateUrls.map(() => new AbortController());

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

    const startFetchTime = Date.now();
    const winner = await Promise.any(
      candidateUrls.map((url, index) =>
        fetchValidImage(
          url,
          baseHeaders,
          upstreamReferer,
          controllers[index].signal,
        ).then((result) => {
          controllers.forEach((ctrl, i) => {
            if (i !== index) ctrl.abort();
          });
          return result;
        }),
      ),
    );
    const fetchTimeMs = Date.now() - startFetchTime;

    const startSharpTime = Date.now();
    const responseBuffer = winner.buffer;
    const contentType = winner.contentType;

    const metadata = await sharp(responseBuffer, {
      failOn: 'none',
      limitInputPixels: false,
    }).metadata();

    if (!metadata.format) {
      throw new UpstreamError('Unsupported image format', 415);
    }

    const width = metadata.width || 800;
    const height = metadata.height || 1200;
    const fileSizeInKB = responseBuffer.length / 1024;

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

    const targetWidth =
      height > 5000
        ? Math.max(baseTargetWidth, Math.min(width, 780))
        : baseTargetWidth;

    let finalBuffer = responseBuffer;
    let finalContentType = contentType || 'image/jpeg';

    if (forceCompression) {
      finalBuffer = await sharp(responseBuffer, {
        failOn: 'none',
        limitInputPixels: false,
        fastShrinkOnLoad: true,
      })
        .rotate()
        .jpeg({
          quality,
          chromaSubsampling: quality < 50 ? '4:2:0' : '4:4:4',
        })
        .toBuffer();
      finalContentType = 'image/jpeg';
    } else if (!shouldResize && isGrayscale) {
      const gray = await makeGrayscaleWithoutResize(responseBuffer, metadata.format);
      finalBuffer = gray.buffer;
      finalContentType = gray.contentType;
    } else if (shouldResize) {
      let pipeline = sharp(responseBuffer, {
        failOn: 'none',
        limitInputPixels: false,
        fastShrinkOnLoad: true,
      }).rotate();

      if (width > targetWidth) {
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
          chromaSubsampling: quality < 50 ? '4:2:0' : '4:4:4',
        })
        .toBuffer();

      if (isGrayscale || compressedBuffer.length < responseBuffer.length) {
        finalBuffer = compressedBuffer;
        finalContentType = 'image/jpeg';
      }
    }

    const sharpTimeMs = Date.now() - startSharpTime;
    const totalServerTimeMs = Date.now() - startTotalTime;

    // 📊 فاحص السرعة: إذا أضفت &debug=1&info=1 يعرض لك سرعة السيرفر والكود بالملي ثانية!
    if (isDebugMode && req.query.info === '1') {
      return res.status(200).json({
        verdict:
          totalServerTimeMs < 1200
            ? '🚀 السيرفر والكود سريعان جداً! البطء من سرعة الإنترنت (3G) في الجوال'
            : '🐢 هناك بطء من الموقع الأصلي أثناء سحب الصورة',
        fetchTimeMs: `${fetchTimeMs} ms (وقت سحب الصورة من الموقع)`,
        sharpTimeMs: `${sharpTimeMs} ms (وقت ضغط الكود للصورة)`,
        totalServerTimeMs: `${totalServerTimeMs} ms (إجمالي وقت السيرفر)`,
        sourceSizeKB: `${Math.round(responseBuffer.length / 1024)} KB`,
        finalSizeKB: `${Math.round(finalBuffer.length / 1024)} KB (الحجم المرسل لجوالك)`,
        appliedQuality: `${quality}%`,
        winnerUrl: winner.candidateUrl,
      });
    }

    res.set({
      'Content-Type': finalContentType,
      'Content-Length': finalBuffer.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Server-Timing': `fetch;dur=${fetchTimeMs}, sharp;dur=${sharpTimeMs}, total;dur=${totalServerTimeMs}`,
    });

    return res.status(200).send(finalBuffer);
  } catch (aggregateError) {
    controllers.forEach((ctrl) => ctrl.abort());
    const errors = aggregateError.errors || [aggregateError];

    if (isDebugMode) {
      return res.status(502).json({
        proxyVersion: 'v4.8-UltraFast',
        requestedUrl: imageUrl,
        failedAttemptsDetails: errors.map((e) => e.details || { message: e.message }),
      });
    }

    const forbiddenErr = errors.find((e) => e.upstreamStatus === 403);
    const primaryErr = forbiddenErr || errors[0] || new UpstreamError('All candidates failed', 403);
    return sendTextError(res, primaryErr);
  }
});

module.exports = app;
