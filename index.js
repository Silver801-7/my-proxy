const express = require('express');
const { request } = require('undici');
const sharp = require('sharp');

const app = express();

app.get('/', async (req, res) => {
    // استقبال الرابط مباشرة دون أي معالجة مسبقة للـ Express
    const rawQuery = req.url.split('url=')[1];
    if (!rawQuery) {
        return res.status(200).send('v6.0-SafeProxy Active');
    }

    // فك التشفير تدريجياً لضمان سلامة الرموز المزدوجة
    let targetUrlString = rawQuery.split('&')[0];
    try {
        targetUrlString = decodeURIComponent(targetUrlString);
        // فك إضافي احتياطي إذا كان مشفراً مرتين بالكامل
        if (targetUrlString.includes('%25')) {
            targetUrlString = decodeURIComponent(targetUrlString);
        }
    } catch (e) {
        targetUrlString = rawQuery;
    }

    // استخراج الهوست والمسار بدقة تامة وبشكل منفصل تماماً
    let parsed;
    try {
        parsed = new URL(targetUrlString);
    } catch (err) {
        return res.status(400).send('Invalid URL Structure');
    }

    const origin = `${parsed.protocol}//${parsed.host}`;
    // استخدام pathname و search معاً لضمان عدم ضياع أي جزء من مسار الفصل أو التوكنات
    const fullPath = parsed.pathname + parsed.search;

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

        // تنفيذ الطلب عبر undici مع فصل الهوست عن المسار بدقة هندسية
        const response = await request(origin, {
            path: fullPath,
            method: 'GET',
            headers: requestHeaders,
            maxRedirections: 5
        });

        if (response.statusCode >= 400) {
            const errorText = await response.body.text();
            return res.status(response.statusCode).send(`Upstream Error (${response.statusCode}): ${errorText}`);
        }

        const imageBuffer = Buffer.from(await response.body.arrayBuffer());
        const fileSizeInKB = imageBuffer.length / 1024;

        // ضغط الصورة حصرياً عبر Sharp
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
            'X-Proxy-Version': '6.0-SafeProxy'
        });

        return res.status(200).send(compressedBuffer);

    } catch (err) {
        return res.status(500).send(`Proxy Internal Error: ${err.message}`);
    }
});

module.exports = app;
