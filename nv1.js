const express = require('express');
const axios = require('axios');
const sharp = require('sharp');

const app = express();

app.get('/', async (req, res) => {
  const imageUrl = req.query.url;
    if (!imageUrl) return res.status(200).send('Proxy Server is Active & Ready!');

      try {
          const response = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                      timeout: 10000,
                            headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                            'Referer': new URL(imageUrl).origin
                                                  }
                                                      });

                                                          const rawQuality = req.query.q || req.query.quality || req.query.l || req.headers['x-image-quality'];
                                                              let quality = rawQuality ? parseInt(rawQuality, 10) : 40;

                                                                  if (isNaN(quality)) quality = 40;
                                                                      quality = Math.max(10, Math.min(100, quality));

                                                                          let pipeline = sharp(response.data);

                                                                              // تطبيق فكرتك: إزالة الألوان وتطبيق أقصى ضغط فقط عند تحديد 10%
                                                                                  if (quality <= 15) {
                                                                                        pipeline = pipeline
                                                                                                .resize({ width: 600, fit: 'inside', withoutEnlargement: true })
                                                                                                        .grayscale() // إزالة الألوان للضغط الأقصى (أقل من 1 ميجا)
                                                                                                                .jpeg({ quality: 10, mozjpeg: true, chromaSubsampling: '4:2:0' });

                                                                                                                    } else if (quality <= 35) {
                                                                                                                          // ضغط قوي مع إبقاء الألوان
                                                                                                                                pipeline = pipeline
                                                                                                                                        .resize({ width: 750, fit: 'inside', withoutEnlargement: true })
                                                                                                                                                .jpeg({ quality: quality, mozjpeg: true, chromaSubsampling: '4:2:0' });

                                                                                                                                                    } else if (quality <= 65) {
                                                                                                                                                          // ضغط متوازن وألوان ممتازة للمانهوا (الإعداد اليومي الموصى به)
                                                                                                                                                                pipeline = pipeline
                                                                                                                                                                        .resize({ width: 1050, fit: 'inside', withoutEnlargement: true })
                                                                                                                                                                                .jpeg({ quality: quality, mozjpeg: true, chromaSubsampling: '4:2:0' });

                                                                                                                                                                                    } else {
                                                                                                                                                                                          // جودة فائقة وأبعاد كاملة
                                                                                                                                                                                                pipeline = pipeline
                                                                                                                                                                                                        .resize({ width: 1400, fit: 'inside', withoutEnlargement: true })
                                                                                                                                                                                                                .jpeg({ quality: quality, mozjpeg: true, chromaSubsampling: '4:4:4' });
                                                                                                                                                                                                                    }

                                                                                                                                                                                                                        const compressedBuffer = await pipeline.toBuffer();

                                                                                                                                                                                                                            res.set('Content-Type', 'image/jpeg');
                                                                                                                                                                                                                                res.set('Cache-Control', 'public, max-age=604800, immutable');
                                                                                                                                                                                                                                    return res.status(200).send(compressedBuffer);

                                                                                                                                                                                                                                      } catch (err) {
                                                                                                                                                                                                                                          console.error('Proxy Error:', err.message);
                                                                                                                                                                                                                                              return res.status(500).send('Error processing image');
                                                                                                                                                                                                                                                }
                                                                                                                                                                                                                                                });

                                                                                                                                                                                                                                                module.exports = app;
                                                                                                                                                                                                                                                