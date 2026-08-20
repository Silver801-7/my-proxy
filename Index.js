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

app.get('/', async (req, res) => {
  // Bandwidth Hero يرسل رابط الصورة عبر الباراميتر url أو l
  const imageUrl = req.query.url || req.query.l;

  if (!imageUrl) {
    return res.status(200).send('Bandwidth Hero Proxy Active');
  }

  try {
    // جلب الصورة مباشرة مع ترويسات تبدو كمتصفح حقيقي لتجاوز الحظر قدر الإمكان
    const response = await axiosInstance.get(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://mangatek.com/',
        'Origin': 'https://mangatek.com/'
      }
    });

    if (response.status !== 200 || !response.data) {
      throw new Error('Failed to fetch');
    }

    // ضغط الصورة عبر Sharp لتقليل حجمها إلى النصف أو الربع لتوفير باقة الإنترنت
    const compressedBuffer = await sharp(response.data, { failOn: 'none' })
      .rotate()
      .resize({ width: 1000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 40, mozjpeg: true })
      .toBuffer();

    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': compressedBuffer.length,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000',
    });

    return res.status(200).send(compressedBuffer);

  } catch (err) {
    // في حال حدث حظر، أعد توجيه الصورة الأصلية مباشرة للتطبيق لكي لا يتوقف الفصل عن الظهور
    try {
      const fallbackRes = await axiosInstance.get(imageUrl);
      return res.status(200).send(fallbackRes.data);
    } catch (e) {
      return res.status(404).send('Error loading image');
    }
  }
});

app.listen(process.env.PORT || 3000);
module.exports = app;
