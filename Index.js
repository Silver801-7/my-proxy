const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const http = require('http');
const https = require('https');

const app = express();

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, rejectUnauthorized: false });

const axiosInstance = axios.create({
  timeout: 20000,
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

// دالة توليد صورة خطأ داكنة ومريحة للعين في حال فشل الجلب النهائي
async function getFallbackImage(error) {
  const svgText = `
    <svg width="600" height="800" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#1a1a1a"/>
      <text x="50%" y="50%" fill="#888888" font-size="24" font-family="Arial" text-anchor="middle">Failed to Load Manga Page</text>
    </svg>
  `;
  return sharp(Buffer.from(svgText)).jpeg({ quality: 80 }).toBuffer();
}

// بناء الروابط البديلة واستهداف CDN مانجا تك مباشرة
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

    // إذا كانت الصورة تابعة لشبكة مانجا تك
    if (host.includes('mangatek.com')) {
      // التأكد من استخدام HTTPS ورابط نظيف
      sourceUrl.protocol = 'https:';
      add(sourceUrl.toString());
    }
  } catch (_) {}

  return candidates;
}

function getQuality(req) {
  const rawQuality = req.query.q || req.query.quality || req.query.l || req.headers['x-image-quality'];
  let quality = 40;
  if (rawQuality !== undefined && rawQuality !== null && rawQuality !== '') {
    quality = Number.parseInt(rawQuality, 10);
    if (Number.isNaN(quality)) quality = 40;
    if (quality === 40) quality = 30;
    quality = Math.max(1, Math.min(100, quality));
  }
  return quality;
}

app.get('/', async (req, res) => {
  const imageUrl = req.query.url;

  if (!imageUrl) {
    return res.status(200).send('v3.3-MangatekDirectCDN Active');
  }

  if (typeof imageUrl !== 'string') {
    const fallbackBuffer = await getFallbackImage(new Error('Invalid URL'));
    res.setHeader('Content-Type', 'image/jpeg');
    return res.status(200).send(fallbackBuffer);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(imageUrl);
  } catch (error) {
    const fallbackBuffer = await getFallbackImage(error);
    res.setHeader('Content-Type', 'image/jpeg');
    return res.status(200).send(fallbackBuffer);
  }

  let upstreamImageUrl = imageUrl;
  let attemptedUpstreams = [];

  try {
    // تحديد نطاق الإحالة الصحيح لخداع حماية الـ Hotlink
    const requestHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Referer': 'https://mangatek.com/',
      'Origin': 'https://mangatek.com/',
      'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site'
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
        const candidateResponse = await axiosInstance.get(candidateUrl, {
          headers: requestHeaders,
        });

        const candidateContentType = String(candidateResponse.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        const candidateBuffer = Buffer.isBuffer(candidateResponse.data) ? candidateResponse.data : Buffer.from(candidateResponse.data || '');

        if (candidateResponse.status < 200 || candidateResponse.status >= 300) {
          throw new UpstreamError(`HTTP ${candidateResponse.status}`, candidateResponse.status);
        }

        // فحص حجم الصورة لكشف صور الحماية الوهمية (الصفراء) التي عادة ما تكون صغيرة جداً
        if (candidateBuffer.length < 2048) {
          throw new UpstreamError('Protected placeholder or blocked image received', 200);
        }

        if (candidateContentType.includes('text/html')) {
          throw new UpstreamError('HTML page returned instead of image', 200);
        }

        let candidateMetadata;
        try {
          candidateMetadata = await sharp(candidateBuffer, { failOn: 'none' }).metadata();
        } catch (err) {
          throw new UpstreamError(`Invalid image payload: ${err.message}`, 200);
        }

        if (!candidateMetadata.format) {
          throw new UpstreamError('Missing image format', 200);
        }

        response = candidateResponse;
        responseBuffer = candidateBuffer;
        contentType = candidateContentType;
        metadata = candidateMetadata;
        break;
      } catch (err) {
        lastCandidateError = err;
      }
    }

    if (!response || !responseBuffer || !metadata) {
      throw lastCandidateError || new UpstreamError('All candidates failed');
    }

    const quality = getQuality(req);
    const isGrayscale = req.query.bw === '1' || req.query.bw === 'true' || req.query.grayscale === '1';

    // معالجة وضغط الصورة عبر Sharp وتثبيت الخلفية البيضاء لمنع الاصفرار
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
      })
      .toBuffer();

    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': compressedBuffer.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Proxy-Version': '3.3-MangatekDirectCDN',
    });

    return res.status(200).send(compressedBuffer);

  } catch (error) {
    const fallbackBuffer = await getFallbackImage(error);
    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': fallbackBuffer.length,
      'Cache-Control': 'no-cache',
      'X-Proxy-Status': 'Error-Fallback',
    });
    return res.status(200).send(fallbackBuffer);
  }
});

app.listen(process.env.PORT || 3000);
module.exports = app;
