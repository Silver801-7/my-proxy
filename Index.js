const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const http = require('http');
const https = require('https');

const app = express();

// إعدادات الاتصال السريع
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, rejectUnauthorized: false });

const axiosInstance = axios.create({
  timeout: 20000,
  responseType: 'arraybuffer',
  httpAgent,
  httpsAgent,
  validateStatus: () => true,
});

// الرابط الخاص بك الذي يعمل كجسر لتجاوز الحظر
const WORKER_PROXY_URL = 'https://my-proxy.ymasalqp-000.workers.dev/?url=';

// دالة لصورة الخطأ
async function getFallbackImage() {
  const svgText = `
    <svg width="600" height="800" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#1a1a1a"/>
      <text x="50%" y="50%" fill="#888888" font-size="24" font-family="Arial" text-anchor="middle">Failed to Load Manga</text>
    </svg>
  `;
  return sharp(Buffer.from(svgText)).jpeg({ quality: 80 }).toBuffer();
}

app.get('/', async (req, res) => {
  const imageUrl = req.query.url;

  if (!imageUrl) {
    return res.status(200).send('v3.5-BridgeActive: All systems operational.');
  }

  try {
    // توجيه الطلب عبر Worker الخاص بك حصرياً
    const finalProxyCall = WORKER_PROXY_URL + encodeURIComponent(imageUrl);
    const response = await axiosInstance.get(finalProxyCall);

    if (response.status !== 200 || response.data.length < 1024) {
      throw new Error('Blocked image');
    }

    // ضغط ومعالجة الصورة لضمان أفضل سرعة على Tachiyomi
    let pipeline = sharp(response.data, { failOn: 'none' })
      .rotate()
      .flatten({ background: '#ffffff' });

    const compressedBuffer = await pipeline
      .resize({ width: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 40, mozjpeg: true, progressive: true })
      .toBuffer();

    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': compressedBuffer.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });

    return res.status(200).send(compressedBuffer);

  } catch (error) {
    const fallbackBuffer = await getFallbackImage();
    res.set({ 'Content-Type': 'image/jpeg' });
    return res.status(200).send(fallbackBuffer);
  }
});

app.listen(process.env.PORT || 3000);
module.exports = app;
