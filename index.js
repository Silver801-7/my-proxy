const express = require('express');
const { request } = require('undici');
const sharp = require('sharp');

const app = express();

app.get('/', async (req, res) => {
    try {
        // الاعتماد على req.query.url بشكل مباشر وآمن لتجنب انهيارات مسارات الـ Vercel
        const targetUrlString = req.query.url;
        
        if (!targetUrlString) {
            return res.status(200).send('v6.3-VercelSafe Active');
        }

        // تحليل الهوست والمسار بطريقة آمنة جداً لا تسبب Crash أبدًا
        let parsed;
        try {
            parsed = new URL(targetUrlString);
        } catch (err) {
            try {
                parsed = new URL(decodeURIComponent(targetUrlString));
            } catch (e) {
                return res.status(400).send('Invalid URL format');
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

        // تنفيذ الطلب عبر undici
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

        // ضغط الصورة حصرياً عبر Sharp بنسبة عالية
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
            'X-Proxy-Version': '6.3-VercelSafe'
        });

        return res.status(200).send(compressedBuffer);

    } catch (err) {
        // التقاط أي استثناء خارجي لمنع شاشة الـ 500 الحمراء الخاصة بـ Vercel تماماً
        return res.status(500).send(`Server Safe Catch: ${err.message}`);
    }
});

module.exports = app;
