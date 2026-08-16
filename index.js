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

// دالة لتوليد صورة صالحة تماماً لمنع انهيار الـ Decoder
async function generateEmergencyPlaceholder() {
    return await sharp({
        create: {
            width: 400,
            height: 300,
            channels: 3,
            background: { r: 20, g: 20, b: 20 }
        }
    })
    .jpeg()
    .toBuffer();
}

app.get('/', async (req, res) => {
    const rawUrlParam = req.query.url;
    if (!rawUrlParam) {
        return res.status(200).send('v3.5-SmartProxy Active (Decoder Safe)');
    } 

    const targetUrlString = rawUrlParam;
    const parsedBase = new URL(targetUrlString);
    const domainOrigin = `${parsedBase.protocol}//${parsedBase.host}`;

    const requestHeaders = {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': domainOrigin + '/',
        'Origin': domainOrigin,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8'
    };

    if (req.headers['cookie']) requestHeaders['Cookie'] = req.headers['cookie'];

    try {
        let response;
        try {
            response = await axiosInstance.get(targetUrlString, { headers: requestHeaders });
        } catch (axiosErr) {
            response = await axiosInstance.get(targetUrlString, { headers: requestHeaders });
        }

        const contentType = response.headers['content-type'] || '';
        if (response.status >= 400 || contentType.includes('text/html')) {
            throw new Error(`Invalid Status or HTML Content`);
        }

        const fileSizeInKB = response.data.length / 1024;

        const rawQuality = req.query.q || req.query.quality || req.query.l || req.headers['x-image-quality'];
        let quality = 40; 

        if (rawQuality) {
            quality = parseInt(rawQuality, 10);
            if (isNaN(quality)) quality = 40;
            if (quality === 40) quality = 30;
            quality = Math.max(1, Math.min(100, quality));
        }

        const dynamicThresholdKB = 680 + ((quality - 10) * 8);
        const isGrayscale = req.query.bw === '1' || req.query.bw === 'true' || req.query.grayscale === '1'; 

        let pipeline = sharp(response.data, { failOn: 'none', fastShrinkOnLoad: true }).rotate(); 

        if (fileSizeInKB > dynamicThresholdKB) {
            const targetWidth = Math.round(517 + (quality / 100) * 1035);
            pipeline = pipeline.resize({
                width: targetWidth,
                fit: 'inside',
                withoutEnlargement: true,
                fastShrinkOnLoad: true
            });
        }

        if (isGrayscale) {
            pipeline = pipeline.grayscale();
        } 

        pipeline = pipeline.jpeg({
            quality: quality,
            mozjpeg: true,
            progressive: true,
            chromaSubsampling: quality < 50 ? '4:2:0' : '4:4:4',
            trellisQuantisation: true,
            overshootDeringing: true
        }); 

        const compressedBuffer = await pipeline.toBuffer(); 

        res.set({
            'Content-Type': 'image/jpeg',
            'Content-Length': compressedBuffer.length,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Proxy-Version': '3.5-DecoderSafe'
        }); 

        return res.status(200).send(compressedBuffer); 

    } catch (err) {
        console.error(`Decoder Safe Fallback triggered for [${targetUrlString}]`);
        try {
            // محاولة جلب الصورة الأصلية مباشرة
            const finalAttempt = await axios.get(targetUrlString, { 
                responseType: 'arraybuffer',
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': domainOrigin + '/' }
            });
            res.set('Content-Type', 'image/jpeg');
            return res.status(200).send(finalAttempt.data);
        } catch (finalErr) {
            // ضمان إرسال صورة صالحة تماماً وليست فارغة لمنع الـ Crash
            const safeBuffer = await generateEmergencyPlaceholder();
            res.set({
                'Content-Type': 'image/jpeg',
                'Content-Length': safeBuffer.length,
                'X-Proxy-Status': 'Emergency-Placeholder'
            });
            return res.status(200).send(safeBuffer);
        }
    }
}); 

module.exports = app;
