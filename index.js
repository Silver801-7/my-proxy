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
    // الحصول على الرابط الخام كما أرسله التطبيق تماماً بدون أي تعديل بشري
    const rawUrlParam = req.query.url;
    if (!rawUrlParam) {
        return res.status(200).send('v3.3-SmartProxy Active (Double-Encoding Fix)');
    } 

    try {
        // استخراج النطاق الأساسي فقط وبناء الرابط بطريقة تحافظ على الرموز الخاصة والترميز المزدوج كما هو
        const parsedBase = new URL(rawUrlParam);
        const domainOrigin = `${parsedBase.protocol}//${parsedBase.host}`;
        
        // استخدام الرابط الخام المحتوي على الترميز المزدوج (%25...) مباشرة دون تعديل المسار
        let finalSafeUrl = rawUrlParam;
        
        const proxyKeys = ['url', 'q', 'quality', 'l', 'bw', 'grayscale'];
        let hasQ = finalSafeUrl.includes('?');

        for (const [key, value] of Object.entries(req.query)) {
            if (!proxyKeys.includes(key) && !finalSafeUrl.includes(`${key}=`)) {
                finalSafeUrl += (hasQ ? '&' : '?') + `${key}=${encodeURIComponent(value)}`;
                hasQ = true;
            }
        }

        const requestHeaders = {
            'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': domainOrigin + '/',
            'Origin': domainOrigin,
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8'
        };

        if (req.headers['cookie']) requestHeaders['Cookie'] = req.headers['cookie'];

        let response;
        try {
            response = await axiosInstance.get(finalSafeUrl, { headers: requestHeaders });
        } catch (axiosErr) {
            // محاولة أخيرة بالرابط الأصلي الخام تماماً بدون أي إضافات
            const directFallback = await axios.get(rawUrlParam, { 
                responseType: 'arraybuffer',
                headers: { 'User-Agent': requestHeaders['User-Agent'], 'Referer': domainOrigin + '/' }
            });
            
            res.set({
                'Content-Type': directFallback.headers['content-type'] || 'image/jpeg',
                'Content-Length': directFallback.data.length,
                'Cache-Control': 'public, max-age=31536000, immutable',
                'X-Proxy-Status': 'Raw-Bypass'
            });
            return res.status(200).send(directFallback.data);
        }

        const contentType = response.headers['content-type'] || '';
        if (response.status >= 400 || contentType.includes('text/html')) {
            throw new Error(`Invalid Response Status`);
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
            'X-Proxy-Version': '3.3-DoubleEncodingFix'
        }); 

        return res.status(200).send(compressedBuffer); 

    } catch (err) {
        try {
            const fallbackDirect = await axios.get(rawUrlParam, { responseType: 'arraybuffer' });
            return res.status(200).send(fallbackDirect.data);
        } catch (e) {
            return res.status(500).send('Critical Error');
        }
    }
}); 

module.exports = app;
