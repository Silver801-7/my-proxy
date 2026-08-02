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

                                                    // قراءة الجودة القادمة من التطبيق (الافتراضي 40 إذا لم تحدد)
                                                        const quality = parseInt(req.query.q) || 40;

                                                            let imagePipeline = sharp(response.data);

                                                                // التحكّم بالأبعاد ديناميكياً بناءً على الجودة المحددة في التطبيق
                                                                    if (quality <= 20) {
                                                                          // ضغط قوي جداً للمواقف التي تحتاج توفير أقصى للبيانات
                                                                                imagePipeline = imagePipeline.resize({ width: 720, fit: 'inside', withoutEnlargement: true });
                                                                                    } else if (quality <= 50) {
                                                                                          // ضغط متوسط وموزون (ممتاز للمانهوا والمانجا اليومية)
                                                                                                imagePipeline = imagePipeline.resize({ width: 1080, fit: 'inside', withoutEnlargement: true });
                                                                                                    }
                                                                                                        // إذا كانت الجودة أعلى من 50%، سيترك أبعاد الصورة الأصلية كما هي بدون تصغير

                                                                                                            // معالجة الضغط مع الحفاظ على الألوان الأصلية
                                                                                                                const compressedBuffer = await imagePipeline
                                                                                                                      .jpeg({ 
                                                                                                                              quality: quality, 
                                                                                                                                      mozjpeg: true,
                                                                                                                                              chromaSubsampling: quality <= 30 ? '4:2:0' : '4:4:4' // ضغط ألوان أعمق فقط عند اختيار جودة منخفضة
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
                                                                                                                                                                                  