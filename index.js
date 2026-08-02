const express = require('express');
const axios = require('axios');
const sharp = require('sharp');

const app = express();

app.get('/', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.send('Proxy is running!');

  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': new URL(imageUrl).origin
      }
    });

    // جلب نسبة الجودة المطلوبة من التطبيق
    const quality = parseInt(req.query.q) || 30;

    // تغيير حجم الصورة وتقليل الجودة لضغط أقصى
    const compressedBuffer = await sharp(response.data)
      .resize({ width: 1080, fit: 'inside', withoutEnlargement: true }) // حد أقصى للعرض 1080px (ممتاز للهواتف)
      .jpeg({ quality: Math.max(quality, 10), progressive: true })
      .toBuffer();

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(compressedBuffer);
  } catch (err) {
    console.error('Proxy Error:', err.message);
    res.status(500).send('Error processing image');
  }
});

module.exports = app;

                                              