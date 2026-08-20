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
  const pipeline = sharp(buffer, { failOn: 'none' }).grayscale().flatten({ background: '#ffffff' }).toColourspace('srgb');

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
    return res.status(200).send('v3.0-StealthBrowserMimic');
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
    const fallbackBuffer = await getFallbackImage(error);

    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': fallbackBuffer.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Proxy-Status': 'Invalid-URL',
    });

    return res.status(200).send(fallbackBuffer);
  }

  let upstreamImageUrl = imageUrl;
  let attemptedUpstreams = [];

  try {
    const domainOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;

    // **محاكاة بصمة المتصفح المتقدمة (Stealth Headers)** لتخطي حراسة مواقع المانجا وسيرفرات الـ CDN
    const requestHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': `${domainOrigin}/`,
      'Origin': domainOrigin,
      'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
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

        break;
      } catch (candidateError) {
        lastCandidateError = candidateError;
      }
    }

    if (!response || !responseBuffer || !metadata) {
      throw lastCandidateError || new UpstreamError('All image candidates failed');
    }

    const fileSizeInKB = responseBuffer.length / 1024;

    // حماية إضافية للصور الصغيرة الفارغة الوهمية
    if (fileSizeInKB < 1.5) {
      res.set({
        'Content-Type': contentType || 'image/webp',
        'Content-Length': responseBuffer.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Proxy-Version': '3.0-StealthBrowserMimic',
        'X-Proxy-Warning': 'Protected-Placeholder-Bypassed'
      });
      return res.status(200).send(responseBuffer);
    }

    const quality = getQuality(req);
    const dynamicThresholdKB = 444 + (quality - 10) * 8;

    const isGrayscale =
      req.query.bw === '1' ||
      req.query.bw === 'true' ||
      req.query.grayscale === '1';

    const shouldResize = fileSizeInKB > dynamicThresholdKB;

    if (!shouldResize && !isGrayscale) {
      res.set({
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': responseBuffer.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Proxy-Version': '3.0-StealthBrowserMimic',
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
        'X-Proxy-Version': '3.0-StealthBrowserMimic',
        'X-Proxy-Debug': `GRAYSCALE_NO_RESIZE|format=${metadata.format}|sourceBytes=${responseBuffer.length}`,
        'X-Source-Format': metadata.format,
      });
      return res.status(200).send(gray.buffer);
    }

    let pipeline = sharp(responseBuffer, {
      failOn: 'none',
      fastShrinkOnLoad: true,
    })
      .rotate()
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb');

    const targetWidth = Math.round(460 + (quality / 100) * 1099);
    pipeline = pipeline.resize({
      width: targetWidth,
      fit: 'inside',
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
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

    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': compressedBuffer.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Proxy-Version': '3.0-StealthBrowserMimic',
      'X-Proxy-Debug': `RESIZED|format=${metadata.format}|sourceBytes=${responseBuffer.length}|targetWidth=${targetWidth}|quality=${quality}`,
      'X-Source-Format': metadata.format,
    });

    return res.status(200).send(compressedBuffer);
  } catch (error) {
    const errorStatus =
      error.upstreamStatus || error.response?.status || 0;

    const errorMessage = error.message || 'Fetch Failed';

    if (req.query.debug === '1' || req.query.debug === 'true') {
      return res.status(502).json({
        proxyVersion: '3.0-StealthBrowserMimic',
        requestedUrl: imageUrl,
        upstreamUrl: upstreamImageUrl,
        attempts: attemptedUpstreams,
        status: errorStatus,
        code: error.code || null,
        message: errorMessage,
        upstreamContentType: error.response?.headers?.['content-type'] || null,
      });
    }

    try {
      const fallbackBuffer = await getFallbackImage(error);

      res.set({
        'Content-Type': 'image/jpeg',
        'Content-Length': fallbackBuffer.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Proxy-Version': '3.0-StealthBrowserMimic',
        'X-Proxy-Status': 'Error-Report',
      });

      return res.status(200).send(fallbackBuffer);
    } catch (fallbackError) {
      return res.status(500).send('Critical Error');
    }
  }
});

module.exports = app;
