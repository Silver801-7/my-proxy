const express = require('express');
const axios = require('axios');
const sharp = require('sharp');

const app = express();

app.get('/', async (req, res) => {
  const imageUrl = req.query.url;
    if (!imageUrl) return res.send('Proxy is running!');

      try {
          const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
              const quality = parseInt(req.query.q) || 40;

                  const compressedBuffer = await sharp(response.data)
                        .jpeg({ quality })
                              .toBuffer();

                                  res.set('Content-Type', 'image/jpeg');
                                      res.send(compressedBuffer);
                                        } catch (err) {
                                            res.status(500).send('Error processing image');
                                              }
                                              });

                                              module.exports = app;
                                              