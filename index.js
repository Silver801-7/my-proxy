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
    responseType: 'arraybuffer',
    httpAgent,
    httpsAgent
}); 

// دالة توليد صورة الأخطاء الملونة بدون نصوص لمنع ظهور المربعات
async function getFallbackImage(errorMessage = 'Unknown Error') {
    let bgColor = '#111111'; // الأسود: خطأ عام في السيرفر

    if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
        bgColor = '#FF4444'; // الأحمر: صورة مكسورة
    } else if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
        bgColor = '#FFCC00'; // الأصفر: انتهى وقت الاتصال
    } else if (errorMessage.includes('403') || errorMessage.includes('Forbidden') || errorMessage.includes('Cloudflare')) {
        bgColor = '#FF8C00'; // البرتقالي: حظر من المصدر
    } else if (errorMessage.includes('Content-Type') || errorMessage.includes('HTML')) {
        bgColor = '#00AAFF'; // الأزرق: خطأ في نوع الملف
    }

    const svgText = `
        <svg width="600" height="400">
            <rect width="100%" height="100%" fill="${bgColor}"/>
        </svg>
    `;

    return await sharp(Buffer.from(svgText))
        .jpeg({ quality: 80 })
        .toBuffer();
} 

app.get('/', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) {
        return res.status(200).send('v2.7-SmartProxy Active (Color-Coded Status)');
    } 

    let lastErrorMsg = '';

    try {
        const parsedUrl = new URL(imageUrl);
        const domainOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;

        const requestHeaders = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
            'Referer': domainOrigin + '/',
            'Origin': domainOrigin,
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Sec-Fetch-Dest': 'image',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'cross-site'
        };

        if (req.headers['cookie']) {
            requestHeaders['Cookie'] = req.headers['cookie'];
        }

        const response = await axiosInstance.get(imageUrl, {
            headers: requestHeaders
        }); 

        const contentType = response.headers['content-type'] || '';
        if (response.status >= 400 || contentType.includes('text/html')) {
            throw new Error(`HTTP ${response.status} or Invalid Content-Type`);
        }

        const fileSizeInKB = response.data.length / 1024;

        const rawQuality = req.query.q || req.query.quality || req.query.l || req.headers['x-image-quality'];
        let quality = 40; 

        if (rawQuality) {
            quality = parseInt(rawQuality, 10);
            if (isNaN(quality)) quality = 40;
            
            if (quality === 40) {
                quality = 30;
            }
            
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
            'X-Proxy-Version': '2.7-SmartProxy'
        }); 

        return res.status(200).send(compressedBuffer); 

    } catch (err) {
        lastErrorMsg = err.message || 'Fetch Failed';
        console.error(`Image Fetch Error [${imageUrl}]:`, lastErrorMsg); 

        try {
            const fallbackBuffer = await getFallbackImage(lastErrorMsg);
            res.set({
                'Content-Type': 'image/jpeg',
                'Content-Length': fallbackBuffer.length,
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'X-Proxy-Status': 'Error-Report'
            });
            return res.status(200).send(fallbackBuffer);
        } catch (fallbackErr) {
            return res.status(500).send('Critical Error');
        }
    }
}); 

module.exports = app;
