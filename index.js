const express = require('express');
const { request } = require('undici');
const sharp = require('sharp');

const app = express();

app.get('/', async (req, res) => {
    try {
        const urlMatch = req.url.match(/[?&]url=([^&]*)/);
        if (!urlMatch || !urlMatch[1]) {
            return res.status(200).send('v6.2-SafeActive');
        }

        const rawQuery = urlMatch[1];
        let targetUrlString = rawQuery;
        
        // فك تشفير آمن 100% ومحمي ضد أي خطأ URIError قد يسبب انهيار السيرفر
        try {
            targetUrlString = decodeURIComponent(rawQuery);
        } catch (e) {
            targetUrlString = rawQuery;
        }

        let parsed;
        try {
            parsed = new URL(targetUrlString);
        } catch (err) {
            // إذا فشل تحليل الرابط المباشر، جرب تحليله بعد فك إضافي حذر
            try {
                const secondDecode = decodeURIComponent(targetUrlString);
                parsed = new URL(secondDecode);
                targetUrlString = secondDecode;
            } catch (innerErr) {
                return res.status(400).send('Invalid URL');
            }
        }

        const origin = `${parsed.protocol}//${parsed.host}`;
        const fullPath = parsed.pathname + parsed.search;

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
            path: fullPath,
            method: 'GET',
            headers: requestHeaders,
            maxRedirections: 5
        });

        if (response.statusCode >= 400) {
            await response.body.text();
            return res.status(response.statusCode).send(`Upstream Error: ${response.statusCode}`);
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
            'X-Proxy-Version': '6.2-CrashProof'
        });

        return res.status(200).send(compressedBuffer);

    } catch (err) {
        return res.status(500).send('Internal Error Handled');
    }
});

module.exports = app;
