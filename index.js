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
    maxRedirects: 10, // السماح بالتوجيه التلقائي للمواقع التي تغير روابطها
    responseType: 'arraybuffer',
    httpAgent,
    httpsAgent
}); 

async function getFallbackImage(errorMessage = 'Unknown Error') {
    let bgColor = '#111111'; 

    if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
        bgColor = '#FF4444'; 
    } else if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
        bgColor = '#FFCC00'; 
    } else if (errorMessage.includes('403') || errorMessage.includes('Forbidden') || errorMessage.includes('Cloudflare')) {
        bgColor = '#FF8C00'; 
    } else if (errorMessage.includes('Content-Type') || errorMessage.includes('HTML')) {
        bgColor = '#00AAFF'; 
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
    const rawUrlParam = req.query.url;
    if (!rawUrlParam) {
        return res.status(200).send('v2.9-SmartProxy Active (URL-Safe Engine)');
    } 

    let lastErrorMsg = '';

    try {
        // 1. إعادة بناء الرابط بدقة لمنع تمزق أي جزء منه
        const targetUrl = new URL(rawUrlParam);
        const proxyKeys = ['url', 'q', 'quality', 'l', 'bw', 'grayscale'];
        
        for (const [key, value] of Object.entries(req.query)) {
            if (!proxyKeys.includes(key)) {
                targetUrl.searchParams.append(key, value);
            }
        }
        
        const finalSafeUrl = targetUrl.href;
        const domainOrigin = `${targetUrl.protocol}//${targetUrl.host}`;

        // 2. ترويسات دقيقة لمحاكاة متصفح التطبيق وتجاوز الحظر
        const requestHeaders = {
            'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': req.headers['referer'] || `${domainOrigin}/`,
            'Accept': req.headers['accept'] || 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': req.headers['accept-language'] || 'ar,en-US;q=0.9,en;q=0.8'
        };

        if (req.headers['cookie']) requestHeaders['Cookie'] = req.headers['cookie'];
        if (req.headers['origin']) requestHeaders['Origin'] = req.headers['origin'];

        // 3. جلب الصورة باستخدام الرابط المتكامل
        const response = await axiosInstance.get(finalSafeUrl, {
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
            if (quality === 40) quality = 30;
            quality = Math.max(1, Math.min(100, quality));
        }

        const dynamicThresholdKB = 680 + ((quality - 10) * 8);
        const isGrayscale = req.query.bw === '1' || req.query.bw === 'true' || req.query.grayscale === '1'; 

        let pipeline = sharp(response.data, { failOn: 'none', fastShrinkOnLoad: true }).rotate(); 

        if (fileSizeInKB > dynamicThresholdKB) {
            const targetWidth = Math.round(500 + (quality / 100) * 1000);
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
            'X-Proxy-Version': '2.9-SmartProxy'
        }); 

        return res.status(200).send(compressedBuffer); 

    } catch (err) {
        lastErrorMsg = err.message || 'Fetch Failed';
        console.error(`Image Fetch Error [${rawUrlParam}]:`, lastErrorMsg); 

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
