const express = require('express');
const sharp = require('sharp');

const app = express();

app.get('/', async (req, res) => {
    const rawUrlParam = req.query.url;
    if (!rawUrlParam) {
        return res.status(200).send('v4.2-NativeFetchProxy Active');
    }

    let targetUrlString = rawUrlParam;
    try {
        targetUrlString = decodeURIComponent(rawUrlParam);
    } catch (e) {
        targetUrlString = rawUrlParam;
    }

    try {
        const parsedBase = new URL(targetUrlString);
        const domainOrigin = `${parsedBase.protocol}//${parsedBase.host}`;

        const requestHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
            'Referer': domainOrigin + '/',
            'Origin': domainOrigin,
            'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'image',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'cross-site'
        };

        if (req.headers['cookie']) {
            requestHeaders['Cookie'] = req.headers['cookie'];
        }

        // استخدام الـ fetch المدمج في Node.js للتعامل المباشر مع الشبكة
        const response = await fetch(targetUrlString, {
            headers: requestHeaders,
            redirect: 'follow'
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('text/html')) {
            throw new Error('Received HTML instead of image');
        }

        const fileSizeInKB = buffer.length / 1024;
        let pipeline = sharp(buffer, { failOn: 'none', fastShrinkOnLoad: true }).rotate();

        if (fileSizeInKB > 700) {
            pipeline = pipeline.resize({
                width: 1200,
                fit: 'inside',
                withoutEnlargement: true
            });
        }

        const compressedBuffer = await pipeline.jpeg({ quality: 40, mozjpeg: true }).toBuffer();

        res.set({
            'Content-Type': 'image/jpeg',
            'Content-Length': compressedBuffer.length,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Proxy-Version': '4.2-NativeFetch'
        });

        return res.status(200).send(compressedBuffer);

    } catch (err) {
        console.error(`Fetch Error for [${targetUrlString}]:`, err.message);
        return res.status(500).send(`Proxy Error: ${err.message}`);
    }
});

module.exports = app;
