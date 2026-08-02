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

                                                    // استخدام أقصى ضغط ممكن مع الحفاظ على النص مقروءاً
                                                        const compressedBuffer = await sharp(response.data)
                                                              .resize({ width: 600, fit: 'inside', withoutEnlargement: true }) // العرض 600px أقصى توفير مع وضوح النص
                                                                    .grayscale() // إزالة الألوان لتقليل بيانات الصورة
                                                                          .jpeg({ 
                                                                                  quality: 15, // دقة 15% (أقل دقة مقروءة)
                                                                                          mozjpeg: true, // استخدام خوارزمية ضغط فائقة
                                                                                                  chromaSubsampling: '4:2:0'
                                                                                                        })
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
                                                                                                                                      