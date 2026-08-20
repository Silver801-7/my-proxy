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

function getErrorText(error) {
  return String(error?.message || error || 'Unknown Error');
}

// تم تعديل لون الخطأ ليصبح رمادياً داكناً أو أسود ليناسب جو القراءة الليلية بدلاً من الأصفر المزعج
async function getFallbackImage(error) {
  const svgText = `
    <svg width="600" height="800" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#1a1a1a"/>
      <text x="50%" y="50%" fill="#888888" font-size="24" font-family="Arial" text-anchor="middle">Failed to Load Manga Page</text>
    </svg>
  `;
  return sharp(Buffer.from(svgText)).jpeg({ quality: 80 }).toBuffer();
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
      sourceUrl.pathname = sourceUrl.pathname.replace(/%(?!25)([0-9a-f]{2})/gi, '%25$1');
      const repairedDirectUrl = sourceUrl.toString();
      add(repairedDirectUrl);

      // إضافة وسيط مجاني خارجي لتجاوز حظر Cloudflare/Datacenter الخاص بـ Vercel
      const proxyWrapped = `https://corsproxy.io/?${encodeURIComponent(repairedDirectUrl)}`;
      add(proxyWrapped);

      const altProxyWrapped = `https://api.allorigins.win/raw?url=${encodeURIComponent(repairedDirectUrl)}`;
      add(altProxyWrapped);

      const mediatorProfiles = [
        { width: '1920', quality: '85' },
        { width: '1280', quality: '80' }
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
    return res.status(200).send('v3.2-HybridProxyBypass Active');
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
    const domainOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;
    const requestHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Referer': `${domainOrigin}/`,
      'Origin': domainOrigin,
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

        if (candidateBuffer.length < 500) {
          // إذا كان الحجم صغيراً جداً، فهذه صورة حماية وهمية وليست صفحة مانجا
          throw new UpstreamError('Protected placeholder detected', 200);
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
      'X-Proxy-Version': '3.2-HybridProxyBypass',
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
