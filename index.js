const express = require('express');
const { request } = require('undici');
const sharp = require('sharp');

const app = express();

app.get('/', async (req, res) => {
    try {
        // استخراج معامل الرابط بأمان تام
        const urlMatch = req.url.match(/[?&]url=([^&]*)/);
        if (!urlMatch || !urlMatch[1]) {
            return res.status(200).send('v6.1-RobustProxy Active');
        }

        const rawQuery = urlMatch[1];
        let targetUrlString;
        
        try {
            targetUrlString = decodeURIComponent(rawQuery);
            // معالجة الرموز المزدوجة (%25) بأمان دون التسبب بانهيار
            if (targetUrlString.includes('%25')) {
                targetUrlString = decodeURIComponent(targetUrlString);
            }
        } catch (e) {
            targetUrlString = rawQuery;
        }

        // تحليل الرابط داخل try/catch لمنع أي Crash نهائياً
        let parsed;
        try {
            parsed = new URL(targetUrlString);
        } catch (err) {
            return res.status(400).send('Invalid URL format');
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

        // جلب الصورة عبر محرك undici
        const response = await request(origin, {
            path: fullPath,
            method: 'GET',
            headers: requestHeaders,
            maxRedirections: 5
        });

        if (response.statusCode >= 400) {
            const errorText = await response.body.text();
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
            'X-Proxy-Version': '6.1-Robust'
        });

        return res.status(200).send(compressedBuffer);

    } catch (err) {
        // التقاط أي خطأ غير متوقع لمنع انهيار الـ Serverless Function تماماً
        return res.status(500).send(`Internal Error: ${err.message}`);
    }
});

module.exports = app;
