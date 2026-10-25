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
  rejectUnauthorized: false,
});

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
 * إرجاع أكواد نصية خفيفة جداً (بضع بايتات فقط) بدلاً من إرسال صور ملونة تستهلك الباقة
 */
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

function buildCandidateImageUrls(imageUrl) {
  const candidates = [];
  const add = (value) => {
    if (typeof value === 'string' && value && !candidates.includes(value)) {
      candidates.push(value);
    }
  };

  add(imageUrl);

  try {
    const sourceUrl = new URL(imageUrl);
    const host = sourceUrl.hostname.toLowerCase();

    if (
      (host === 'appswat.com' || host === 'meshmanga.com') &&
      sourceUrl.pathname.startsWith('/v2/media/')
    ) {
      sourceUrl.hostname = 'meshmanga.com';

      sourceUrl.pathname = sourceUrl.pathname.replace(
        /%(?!25)([0-9a-f]{2})/gi,
        '%25$1',
      );

      const repairedDirectUrl = sourceUrl
        .toString()
        .replace(/%25e2%80%99/gi, '%25e2%2580%2599')
        .replace(/%e2%80%99/gi, '%25e2%2580%2599');

      add(repairedDirectUrl);

      const mediatorProfiles = [
        { width: '3840', quality: '100' },
        { width: '1920', quality: '100' },
        { width: '1920', quality: '75' },
      ];

      for (const profile of mediatorProfiles) {
        const nextImageUrl = new URL('https://meshmanga.com/_next/image');
        nextImageUrl.searchParams.set('url', repairedDirectUrl);
        nextImageUrl.searchParams.set('w', profile.width);
        nextImageUrl.searchParams.set('q', profile.quality);
        add(nextImageUrl.toString());
      }
    }
  } catch (_) {}

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
  return Number.parseInt(rawQuality, 10) === 95;
}

function getQuality(req) {
  const rawQuality = getRequestedQuality(req);

  let quality = 40;

  if (rawQuality !== undefined && rawQuality !== null && rawQuality !== '') {
    quality = Number.parseInt(rawQuality, 10);

    if (Number.isNaN(quality)) {
      quality = 40;
    }

    if (quality === 40) {
      quality = 35;
    }

    if (quality === 95) {
      quality = 45;
    }

    quality = Math.max(1, Math.min(100, quality));
  }

  return quality;
}

app.get('/', async (req, res) => {
  const imageUrl = req.query.url;

  if (!imageUrl) {
    return res.status(200).send('v2.9-DataSaver-SmartLongStrip');
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
    console.error('Invalid image URL:', {
      imageUrl,
      message: error.message,
    });
    return sendTextError(res, error);
  }

  let upstreamImageUrl = imageUrl;
  let attemptedUpstreams = [];

  try {
    const requestHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      Accept:
        'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
    };

    const upstreamReferer =
      typeof req.query.referer === 'string'
        ? req.query.referer
        : process.env.UPSTREAM_REFERER;

    if (upstreamReferer) {
      requestHeaders.Referer = upstreamReferer;
    }

    if (process.env.FORWARD_UPSTREAM_COOKIE === 'true' && req.headers.cookie) {
      requestHeaders.Cookie = req.headers.cookie;
    }

    const candidateUrls = buildCandidateImageUrls(imageUrl);
    attemptedUpstreams = candidateUrls;

    let response = null;
    let responseBuffer = null;
    let contentType = '';
    let finalUrl = '';
    let metadata = null;
    let lastCandidateError = null;

    for (const candidateUrl of candidateUrls) {
      upstreamImageUrl = candidateUrl;

      try {
        const candidateResponse = await axiosInstance.get(candidateUrl, {
          headers: requestHeaders,
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
            `Upstream HTTP ${candidateResponse.status} (${candidateResponse.statusText || 'request failed'})`,
            candidateResponse.status,
          );
        }

        if (candidateBuffer.length === 0) {
          throw new UpstreamError(
            'Invalid image: empty response',
            candidateResponse.status,
          );
        }

        if (candidateContentType.includes('text/html')) {
          throw new UpstreamError(
            `Invalid Content-Type: ${candidateContentType}`,
            candidateResponse.status,
          );
        }

        let candidateMetadata;
        try {
          candidateMetadata = await sharp(candidateBuffer, {
            failOn: 'none',
            limitInputPixels: false,
          }).metadata();
        } catch (error) {
          throw new UpstreamError(
            `Invalid image payload: ${error.message}`,
            candidateResponse.status,
          );
        }

        if (!candidateMetadata.format) {
          throw new UpstreamError(
            `Invalid image format; Content-Type=${candidateContentType || 'missing'}`,
            candidateResponse.status,
          );
        }

        response = candidateResponse;
        responseBuffer = candidateBuffer;
        contentType = candidateContentType;
        metadata = candidateMetadata;
        finalUrl = candidateResponse.request?.res?.responseUrl || candidateUrl;

        console.log('UPSTREAM IMAGE RESPONSE:', {
          requestedUrl: imageUrl,
          selectedUpstreamUrl: candidateUrl,
          finalUrl,
          status: candidateResponse.status,
          contentType,
          bytes: responseBuffer.length,
          attempts: attemptedUpstreams,
        });

        break;
      } catch (candidateError) {
        lastCandidateError = candidateError;
        console.error('IMAGE CANDIDATE FAILED:', {
          requestedUrl: imageUrl,
          candidateUrl,
          status: candidateError.upstreamStatus || 0,
          message: candidateError.message || String(candidateError),
        });
      }
    }

    if (!response || !responseBuffer || !metadata) {
      throw lastCandidateError || new UpstreamError('All image candidates failed');
    }

    const width = metadata.width || 800;
    const height = metadata.height || 1200;
    const fileSizeInKB = responseBuffer.length / 1024;
    const quality = getQuality(req);

    // معادلتك الأصلية 100%
    const dynamicThresholdKB = 100 + (quality - 10) * 5;

    // فحص هل الصورة شريط طويل جداً (الطول أكثر من 3 أضعاف العرض أو أطول من 3500 بكسل)
    const isLongStrip = height / width >= 3.0 || height > 3500;

    /*
     * لتوفير الباقة بأقصى درجة مع عدم ظلم الصور الطويلة:
     * بدلاً من فتح الباب على مصراعيه لكل صفحة، نسمح للصورة الطويلة بزيادة طفيفة جداً في الحد
     * (نصف الحد فقط لكل 3000 بكسل طول إضافي)، بحيث لو كانت كبيرة تُضغط فوراً لتوفير الباقة!
     */
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
        fastShrinkOnLoad: !isLongStrip, // إيقافها للصور الطويلة يمنع تكسر الحروف بدون زيادة الحجم
      })
        .rotate()
        .jpeg({
          quality,
          mozjpeg: true,
          progressive: true,
          chromaSubsampling: quality < 50 ? '4:2:0' : '4:4:4', // نفس معادلتك لتوفير الباقة
          trellisQuantisation: true,
          overshootDeringing: true,
        })
        .toBuffer();

      res.set({
        'Content-Type': 'image/jpeg',
        'Content-Length': forcedBuffer.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Proxy-Version': '2.9-MultiFallback',
        'X-Proxy-Debug': `FORCED_COMPRESSED|requestedQuality=95|quality=${quality}|sourceBytes=${responseBuffer.length}|outputBytes=${forcedBuffer.length}|format=${metadata.format}`,
        'X-Source-Format': metadata.format,
      });

      return res.status(200).send(forcedBuffer);
    }

    if (!shouldResize && !isGrayscale) {
      res.set({
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': responseBuffer.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Proxy-Version': '2.9-MultiFallback',
        'X-Proxy-Debug': `ORIGINAL|format=${metadata.format}|sourceBytes=${responseBuffer.length}`,
        'X-Source-Format': metadata.format,
      });
      return res.status(200).send(responseBuffer);
    }

    if (!shouldResize && isGrayscale) {
      const gray = await makeGrayscaleWithoutResize(responseBuffer, metadata.format);
      res.set({
        'Content-Type': gray.contentType,
        'Content-Length': gray.buffer.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Proxy-Version': '2.9-MultiFallback',
        'X-Proxy-Debug': `GRAYSCALE_NO_RESIZE|format=${metadata.format}|sourceBytes=${responseBuffer.length}`,
        'X-Source-Format': metadata.format,
      });
      return res.status(200).send(gray.buffer);
    }

    let pipeline = sharp(responseBuffer, {
      failOn: 'none',
      limitInputPixels: false,
      // السر هنا: في الصور الطويلة نوقف fastShrinkOnLoad حتى لا تتكسر الكتابة أثناء التصغير
      fastShrinkOnLoad: !isLongStrip,
    }).rotate();

    // معادلتك الأصلية للعرض
    const baseTargetWidth = Math.round(390 + (quality / 100) * 900);

    // إذا كانت صورة طويلة جداً (أطول من 5000 بكسل)، لا نكسر عرضها لأقل من 780 بكسل حتى تظل القراءة واضحة، مع ضغطها بنفس جودتك المنخفضة لتوفير الباقة
    const targetWidth =
      height > 5000
        ? Math.max(baseTargetWidth, Math.min(width, 780))
        : baseTargetWidth;

    pipeline = pipeline.resize({
      width: targetWidth,
      fit: 'inside',
      withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3, // يحافظ على حدة الخطوط والملامح عند التصغير بدون زيادة ولا بايت في الحجم
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
        chromaSubsampling: quality < 50 ? '4:2:0' : '4:4:4', // نفس معادلتك لتوفير الباقة
        trellisQuantisation: true,
        overshootDeringing: true,
      })
      .toBuffer();

    // حماية إضافية لباقتك: إذا كانت الصورة الأصلية أصغر من المضغوطة، أرسل الأصل الأصغر!
    if (!isGrayscale && compressedBuffer.length >= responseBuffer.length) {
      res.set({
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': responseBuffer.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Proxy-Version': '2.9-MultiFallback',
        'X-Proxy-Debug': `ORIGINAL_SMALLER|sourceBytes=${responseBuffer.length}|compressedBytes=${compressedBuffer.length}`,
        'X-Source-Format': metadata.format,
      });
      return res.status(200).send(responseBuffer);
    }

    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': compressedBuffer.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Proxy-Version': '2.9-MultiFallback',
      'X-Proxy-Debug': `RESIZED|long=${isLongStrip}|format=${metadata.format}|sourceBytes=${responseBuffer.length}|outputBytes=${compressedBuffer.length}|targetWidth=${targetWidth}|quality=${quality}`,
      'X-Source-Format': metadata.format,
    });

    return res.status(200).send(compressedBuffer);
  } catch (error) {
    const errorStatus =
      error.upstreamStatus || error.response?.status || 0;

    const errorMessage = error.message || 'Fetch Failed';

    if (req.query.debug === '1' || req.query.debug === 'true') {
      return res.status(502).json({
        proxyVersion: '2.8-Debuggable',
        requestedUrl: imageUrl,
        upstreamUrl: upstreamImageUrl,
        attempts: attemptedUpstreams,
        status: errorStatus,
        code: error.code || null,
        message: errorMessage,
        upstreamContentType: error.response?.headers?.['content-type'] || null,
      });
    }

    console.error('IMAGE PROXY ERROR:', {
      imageUrl,
      upstreamUrl: upstreamImageUrl,
      attempts: attemptedUpstreams,
      status: errorStatus,
      code: error.code || '',
      message: errorMessage,
      upstreamContentType: error.response?.headers?.['content-type'] || '',
    });

    const debugHeader = `ERROR|attempts=${attemptedUpstreams.length}|status=${errorStatus}|message=${encodeURIComponent(errorMessage.slice(0, 140))}`;
    return sendTextError(res, error, debugHeader);
  }
});

module.exports = app;
