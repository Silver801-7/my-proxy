const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const http = require('http');
const https = require('https'); 

const app = express(); 

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ 
    keepAlive: true, 
    maxSockets: 50,
    rejectUnauthorized: false
}); 

const axiosInstance = axios.create({
    timeout: 15000, 
    maxRedirects: 10,
    responseType: 'arraybuffer',
    httpAgent,
    httpsAgent
}); 

async function createPlaceholder(text = 'Error') {
    return await sharp({
        create: {
            width: 400,
            height: 300,
            channels: 3,
            background: { r: 180, g: 30, b: 30 }
        }
    })
    .jpeg()
    .toBuffer();
}

app.get('/', async (req, res) => {
    const rawUrlParam = req.query.url;
    if (!rawUrlParam) {
        return res.status(200).send('v3.6-SmartProxy Active (Strict Buffer Guard)');
    } 

    const targetUrlString = rawUrlParam;

    try {
        const parsedBase = new URL(targetUrlString);
        const domainOrigin = `${parsedBase.protocol}//${parsedBase.host}`;

        const requestHeaders = {
            'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': domainOrigin + '/',
            'Origin': domainOrigin,
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        };

        if (req.headers['cookie']) requestHeaders['Cookie'] = req.headers['cookie'];

        let response;
        try {
            response = await axiosInstance.get(targetUrlString, { headers: requestHeaders });
        } catch (e) {
            // محاولة أخيرة مباشرة بدون هيدرز معقدة
            response = await axios.get(targetUrlString, { responseType: 'arraybuffer' });
        }

        const contentType = (response.headers['content-type'] || '').toLowerCase();
        
        // إذا كان السيرفر قد أرجع صفحة HTML أو خطأ، لا تقم بتمريرها بل حولها لصورة صالحة فوراً
        if (response.status >= 400 || contentType.includes('text/html') || contentType.includes('text/plain')) {
            throw new Error('Received HTML or Text instead of Image');
        }

        // معالجة الضغط عبر Sharp لضمان إخراج صورة JPEG سليمة نظامياً
        let pipeline = sharp(response.data, { failOn: 'none', fastShrinkOnLoad: true }).rotate();
        
        const fileSizeInKB = response.data.length / 1024;
        const rawQuality = req.query.q || req.query.quality || req.query.l || 40;
        let quality = parseInt(rawQuality, 10);
        if (isNaN(quality)) quality = 40;
        quality = Math.max(1, Math.min(100, quality));

        if (fileSizeInKB > 700) {
            pipeline = pipeline.resize({
                width: 1200,
                fit: 'inside',
                withoutEnlargement: true
            });
        }

        const compressedBuffer = await pipeline.jpeg({ quality: quality, mozjpeg: true }).toBuffer(); 

        res.set({
            'Content-Type': 'image/jpeg',
            'Content-Length': compressedBuffer.length,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Proxy-Version': '3.6-StrictGuard'
        }); 

        return res.status(200).send(compressedBuffer); 

    } catch (err) {
        console.error(`Bypassed Decoder Crash for [${targetUrlString}]:`, err.message);
        
        // في أ أسوأ الظروف، نقوم بتوليد صورة صالحة وإرسالها لتجنب انهيار التطبيق
        try {
            const fallbackBuffer = await createPlaceholder();
            res.set({
                'Content-Type': 'image/jpeg',
                'Content-Length': fallbackBuffer.length,
                'X-Proxy-Status': 'Safe-Placeholder'
            });
            return res.status(200).send(fallbackBuffer);
        } catch (critErr) {
            return res.status(500).send('Internal Error');
        }
    }
}); 

module.exports = app;
