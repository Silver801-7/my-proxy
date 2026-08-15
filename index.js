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

app.get('/', async (req, res) => {
    const rawUrlParam = req.query.url;
    if (!rawUrlParam) {
        return res.status(200).send('v3.1-SmartProxy Active (Auto-Redirect Bypass)');
    } 

    try {
        const targetUrl = new URL(rawUrlParam);
        const proxyKeys = ['url', 'q', 'quality', 'l', 'bw', 'grayscale'];
        
        for (const [key, value] of Object.entries(req.query)) {
            if (!proxyKeys.includes(key)) {
                targetUrl.searchParams.append(key, value);
            }
        }
        
        const finalSafeUrl = targetUrl.href;
        const exactOrigin = `${targetUrl.protocol}//${targetUrl.host}`;

        const requestHeaders = {
            'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': exactOrigin + '/',
            'Origin': exactOrigin,
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8'
        };

        if (req.headers['cookie']) requestHeaders['Cookie'] = req.headers['cookie'];

        let response;
        try {
            response = await axiosInstance.get(finalSafeUrl, { headers: requestHeaders });
        } catch (axiosErr) {
            // **الحل الجذري هنا**: إذا رفض السيرفر الطلب (حظر/404)، قم بتحويل الطلب للرابط الأصلي مباشرة لتفادي اللون الأحمر!
            console.warn(`Proxy fetch failed for [${finalSafeUrl}], redirecting to direct URL.`);
            return res.redirect(302, rawUrlParam);
        }

        const contentType = response.headers['content-type'] || '';
        if (response.status >= 400 || contentType.includes('text/html')) {
            // إذا كان الرد HTML (حماية كلوترافير أو صفحة خطأ)، اعبر للرابط الأصلي فوراً
            return res.redirect(302, rawUrlParam);
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
            const targetWidth = Math.round(517 + (quality / 100) * 1035); // الثوابت المستقرة لضمان وضوح النصوص
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
            'X-Proxy-Version': '3.1-SmartBypass'
        }); 

        return res.status(200).send(compressedBuffer); 

    } catch (err) {
        // في حال حدوث أي خطأ برمجي غير متوقع، يتم التوجيه للرابط الأصلي لضمان عدم توقف القراءة نهائياً
        return res.redirect(302, rawUrlParam);
    }
}); 

module.exports = app;
