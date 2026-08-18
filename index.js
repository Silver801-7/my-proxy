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

function buildCandidateImageUrls(imageUrl) {
  const candidates = [];
  const add = (value) => {
    if (typeof value === 'string' && value && !candidates.includes(value)) {
      candidates.push(value);
    }
  };

  // أي موقع غير MeshManga يبقى على مساره الأصلي بدون تغيير.
  add(imageUrl);

  try {
    const sourceUrl = new URL(imageUrl);
    const host = sourceUrl.hostname.toLowerCase();

    if (
      (host === 'appswat.com' || host === 'meshmanga.com') &&
      sourceUrl.pathname.startsWith('/v2/media/')
    ) {
      sourceUrl.hostname = 'meshmanga.com';

      /* دعم الروابط التي تصل بترميز قديم أو مفكوك جزئياً. */
      sourceUrl.pathname = sourceUrl.pathname.replace(
        /%(?!25)([0-9a-f]{2})/gi,
        '%25$1',
      );

      const repairedDirectUrl = sourceUrl
        .toString()
        .replace(/%25e2%80%99/gi, '%25e2%2580%2599')
        .replace(/%e2%80%99/gi, '%25e2%2580%2599');

      // نجرّب الرابط المباشر أولاً للحفاظ على الأصل إذا كان متاحاً.
      add(repairedDirectUrl);

      /*
       * إذا احتجنا Next Image، نطلب أعلى نسخة ممكنة أولاً:
       * q=100 وw=3840. البدائل التالية لا تُنفذ إلا إذا فشلت السابقة؛
       * لذلك لا توجد ثلاث عمليات ضغط للصورة نفسها.
       */
      const mediatorProfiles = [
        { width: '3840', quality: '100' },
        { width: '1920', quality: '100' },
        { width: '1920', quality: '75' }, // توافق مع الطريقة السابقة
      ];

      for (const profile of mediatorProfiles) {
        const nextImageUrl = new URL('https://meshmanga.com/_next/image');
        nextImageUrl.searchParams.set('url', repairedDirectUrl);
        nextImageUrl.searchParams.set('w', profile.width);
        nextImageUrl.searchParams.set('q', profile.quality);
        add(nextImageUrl.toString());
      }
    }
  } catch (_) {
    // سيجري التعامل مع الرابط الأصلي في مرحلة التحقق الرئيسية.
  }

  return candidates;
}

async function makeGrayscaleWithoutResize(buffer, format) {
  const pipeline = sharp(buffer, { failOn: 'none' }).grayscale();

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
    return res.status(200).send('v2.9-MultiFallback');
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

  let upstreamImageUrl = imageUrl;
  let attemptedUpstreams = [];

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

    /* تجربة خاصة بصور MangaTek فقط؛ لا تؤثر على MeshManga أو المواقع الأخرى. */
    if (parsedUrl.hostname.toLowerCase() === 'img.mangatek.com') {
      requestHeaders.Referer = 'https://mangatek.com/';
      requestHeaders.Origin = 'https://mangatek.com';
    }

    /* لا تمرر Cookie إلا عند تفعيله صراحةً. */
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

    const fileSizeInKB = responseBuffer.length / 1024;
    const quality = getQuality(req);
    const dynamicThresholdKB = 660 + (quality - 20) * 8;

    const isGrayscale =
      req.query.bw === '1' ||
      req.query.bw === 'true' ||
      req.query.grayscale === '1';

    const shouldResize = fileSizeInKB > dynamicThresholdKB;

    /* صورة ملونة تحت الحد: إرجاع المصدر كما وصل، بلا resize أو JPEG. */
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

    /* صورة صغيرة مع Grayscale: نحذف اللون بلا تصغير، وبأقرب إخراج lossless متاح. */
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
      fastShrinkOnLoad: true,
    }).rotate();

    const targetWidth = Math.round(460 + (quality / 100) * 1200);
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
      'X-Proxy-Version': '2.9-MultiFallback',
      'X-Proxy-Debug': `RESIZED|format=${metadata.format}|sourceBytes=${responseBuffer.length}|targetWidth=${targetWidth}|quality=${quality}`,
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
        proxyVersion: '2.9-MultiFallback',
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

    try {
      const fallbackBuffer = await getFallbackImage(error);

      res.set({
        'Content-Type': 'image/jpeg',
        'Content-Length': fallbackBuffer.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Proxy-Version': '2.9-MultiFallback',
        'X-Proxy-Status': 'Error-Report',
        'X-Proxy-Debug': `ERROR|attempts=${attemptedUpstreams.length}|status=${errorStatus}|message=${encodeURIComponent(errorMessage.slice(0, 140))}`,
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

/*
 * ملاحظات:
 * 1. إذا كنت تبني رابط البروكسي في جهة أخرى، استخدم:
 *
 *    const proxy = new URL(PROXY_URL);
 *    proxy.searchParams.set('url', imageUrl);
 *    const finalProxyUrl = proxy.toString();
 *
 *    ولا تضع imageUrl مباشرة بعد ?url= إذا كان يحتوي على & أو token.
 *
 * 2. لا تترك rejectUnauthorized:false في الإنتاج إلا لسبب واضح.
 *
 * 3. أضف allowlist للدومينات قبل نشر endpoint يقبل
 */
