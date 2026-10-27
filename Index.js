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

// 1. تعديل بصمة TLS لتقليد متصفح Chrome على Vercel
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
  timeout: 12000, // تقليل المهلة قليلاً لتناسب حدود Vercel Serverless
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

function buildCandidateImageUrls(imageUrl) {
  const candidates = [];
  const add = (value) => {
    if (typeof value === 'string' && value && !candidates.includes(value)) {
      candidates.push(value);
    }
  };

  add(imageUrl);

  let cleanTargetUrl = imageUrl;

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

      cleanTargetUrl = repairedDirectUrl;
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

  // 2. إذا وضعت رابط Cloudflare Worker في إعدادات Environment Variables في Vercel
  if (process.env.CF_WORKER_URL) {
    const baseWorker = process.env.CF_WORKER_URL.replace(/\/$/, '');
    add(`${baseWorker}/?url=${encodeURIComponent(cleanTargetUrl)}`);
  }

  // 3. وسطاء صور مجانيين (لتجاوز حظر IP Vercel تلقائياً بدون إعدادات خارجية)
  add(`https://wsrv.nl/?url=${encodeURIComponent(cleanTargetUrl)}&default=1`);
  
  try {
    const parsedForJetpack = new URL(cleanTargetUrl);
    if (parsedForJetpack.protocol === 'https:') {
      add(`https://i0.wp.com/${parsedForJetpack.host}${parsedForJetpack.pathname}${parsedForJetpack.search}`);
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
    // توليد Referer تلقائي من نفس دومين الصورة لتجنب الحظر
    const defaultReferer = `${parsedUrl.protocol}//${parsedUrl.hostname}/`;
    const upstreamReferer =
      typeof req.query.referer === 'string'
        ? req.query.referer
        : process.env.UPSTREAM_REFERER || defaultReferer;

    const requestHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept:
        'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
      Referer: upstreamReferer,
      'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
    };

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
        proxyVersion: '2.9-VercelReady',
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
