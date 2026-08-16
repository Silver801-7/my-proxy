const express = require('express');
const { request } = require('undici');
const sharp = require('sharp');

const app = express();

app.get('/', async (req, res) => {
    const urlMatch = req.url.match(/[?&]url=([^&]*)/);
    if (!urlMatch || !urlMatch[1]) {
        return res.status(200).send('Enterprise Redirect-Fallback Proxy Active');
    }

    const encodedUrlParam = urlMatch[1];
    let targetUrlString;
    try {
        targetUrlString = decodeURIComponent(encodedUrlParam);
    } catch (e) {
        targetUrlString = encodedUrlParam;
    }

    // إذا فشل البروكسي السحابي بسبب حظر الـ IP، وجه المتصفح للرابط الأصلي مباشرة ليعمل بدون أي ألوان حمراء
    const fallbackRedirect = () => {
        return res.redirect(302, targetUrlString);
    };

    const isHttps = targetUrlString.startsWith('https');
    const protoLength = isHttps ? 8 : 7;
    const remainder = targetUrlString.substring(protoLength);
    const firstSlash = remainder.indexOf('/');
    
    const hostname = firstSlash === -1 ? remainder : remainder.substring(0, firstSlash);
    const rawPath = firstSlash === -1 ? '/' : remainder.substring(firstSlash);
    const origin = `${isHttps ? 'https' : 'http'}://${hostname}`;

    try {
        const requestHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Referer': origin + '/',
            'Origin': origin
        };

        if (req.headers['cookie']) {
            requestHeaders['Cookie'] = req.headers['cookie'];
        }

        const response = await request(origin, {
            path: rawPath,
            method: 'GET',
            headers: requestHeaders,
            maxRedirections: 5
        });

        if (response.statusCode >= 400) {
            await response.body.text();
            return fallbackRedirect();
        }

        const imageBuffer = Buffer.from(await response.body.arrayBuffer());
        const fileSizeInKB = imageBuffer.length / 1024;

        let pipeline = sharp(imageBuffer, { failOn: 'none', fastShrinkOnLoad: true }).rotate();

        if (fileSizeInKB > 700) {
            pipeline = pipeline.resize({
                width: 1200,
                fit: 'inside',
                withoutEnlargement: true
            });
        }

        const compressedBuffer = await pipeline.jpeg({
            quality: 40,
            mozjpeg: true
        }).toBuffer();

        res.set({
            'Content-Type': 'image/jpeg',
            'Content-Length': compressedBuffer.length,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Proxy-Version': '5.2-SmartRedirect'
        });

        return res.status(200).send(compressedBuffer);

    } catch (err) {
        return fallbackRedirect();
    }
});

module.exports = app;
