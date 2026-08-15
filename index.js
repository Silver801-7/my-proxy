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
        return res.status(200).send('v3.2-SmartProxy Active (Direct Buffer Fallback)');
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
            // **الحل الجذري الحقيقي**: إذا فشل البروكسي، لا ترجع صورة حمراء، بل اسحب الصورة الأصلية مباشرة وأرسلها للتطبيق كبايتات صالحة!
            console.warn(`Proxy failed, fetching original image directly for: ${finalSafeUrl}`);
            const directResponse = await axios.get(finalSafeUrl, { 
                responseType: 'arraybuffer',
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': exactOrigin + '/' }
            });
            
            res.set({
                'Content-Type': directResponse.headers['content-type'] || 'image/jpeg',
                'Content-Length': directResponse.data.length,
                'Cache-Control': 'public, max-age=31536000, immutable',
                'X-Proxy-Status': 'Bypassed-Direct'
            });
            return res.status(200).send(directResponse.data);
        }

        const contentType = response.headers['content-type'] || '';
        if (response.status >= 400 || contentType.includes('text/html')) {
            throw new Error(`Invalid Response Status or HTML Content`);
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
            'X-Proxy-Version': '3.2-SmartProxy'
        }); 

        return res.status(200).send(compressedBuffer); 

    } catch (err) {
        // إذا حدث خطأ نهائي، جرب إرسال الصورة الأصلية مباشرة بدلاً من المربع الأحمر الوهمي
        try {
            const fallbackDirect = await axios.get(rawUrlParam, { responseType: 'arraybuffer' });
            return res.status(200).send(fallbackDirect.data);
        } catch (e) {
            return res.status(500).send('Critical Error');
        }
    }
}); 

module.exports = app;
