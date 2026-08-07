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

// الـ User-Agent الخاص بتطبيقك مباشرة
const APP_USER_AGENT = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

const axiosInstance = axios.create({
    timeout: 15000, 
    responseType: 'arraybuffer',
    httpAgent,
    httpsAgent,
    validateStatus: () => true 
}); 

const COVER_PATTERNS = [
    'cover', 'thumb', 'poster', 'avatar', 'banner', 'front',
    'thumbnail', 'card', 'preview', 'jacket', 'artwork', 
    '_small', '_medium', '300x', '250x', '200x', '.thumb.', '-thumb-',
    'cover_url', 'thumbnail_url'
]; 

async function getFallbackImage() {
    return await sharp({
        create: {
            width: 400,
            height: 600,
            channels: 3,
            background: { r: 40, g: 10, b: 10 } 
        }
    })
    .jpeg({ quality: 10 })
    .toBuffer();
}

function checkIfCover(url) {
    if (!url) return false;
    return COVER_PATTERNS.some(pattern => url.toLowerCase().includes(pattern));
} 

app.get('/', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) {
        return res.status(200).send('v1.7-SmartProxy Active (App UA Linked)');
    } 

    try {
        // دمج User-Agent التطبيق مع تمرير الـ Cookies والـ Referer إن وجدوا من التطبيق
        const requestHeaders = {
            'Referer': req.headers['referer'] || req.headers['origin'] || new URL(imageUrl).origin,
            'User-Agent': req.headers['user-agent'] || APP_USER_AGENT,
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate',
            'Sec-Fetch-Dest': 'image',
            'Sec-Fetch-Mode': 'no-cors',
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
            throw new Error(`Status: ${response.status} - Content: ${contentType.split(';')[0]}`);
        }

        const isCover = checkIfCover(imageUrl); 
        const rawQuality = req.query.q || req.query.quality || req.query.l || req.headers['x-image-quality'];
        
        let quality;
        let targetWidth;

        if (rawQuality) {
            quality = parseInt(rawQuality, 10);
            if (isNaN(quality)) quality = 40;
            quality = Math.max(1, Math.min(100, quality));
            targetWidth = isCover ? 280 : Math.round(450 + (quality / 100) * 900);
        } else if (isCover) {
            targetWidth = 280; 
            quality = 20;     
        } else {
            quality = 40;
            targetWidth = Math.round(450 + (quality / 100) * 900);
        }

        const isGrayscale = req.query.bw === '1' || req.query.bw === 'true' || req.query.grayscale === '1'; 

        let pipeline = sharp(response.data, { failOn: 'none', fastShrinkOnLoad: true })
            .rotate()
            .resize({
                width: targetWidth,
                fit: 'inside',
                withoutEnlargement: true,
                fastShrinkOnLoad: true
            }); 

        if (isGrayscale && !isCover) pipeline = pipeline.grayscale();

        pipeline = pipeline.jpeg({
            quality: quality,
            mozjpeg: true,
            progressive: true,
            chromaSubsampling: isCover ? '4:2:0' : (isGrayscale ? '4:2:0' : (quality < 50 ? '4:2:0' : '4:4:4')),
            trellisQuantisation: true,
            overshootDeringing: true
        }); 

        const compressedBuffer = await pipeline.toBuffer(); 

        res.set({
            'Content-Type': 'image/jpeg',
            'Content-Length': compressedBuffer.length,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Proxy-Version': '1.7-SmartProxy',
            'X-Image-Type': isCover ? 'Cover' : 'Chapter'
        }); 

        return res.status(200).send(compressedBuffer); 

    } catch (err) {
        let errorReason = err.message;
        if (err.response) {
            errorReason = `Status: ${err.response.status}`;
        }

        console.error(`[Error] Fetching ${imageUrl}:`, errorReason); 

        try {
            const fallbackBuffer = await getFallbackImage();
            res.set({
                'Content-Type': 'image/jpeg',
                'Content-Length': fallbackBuffer.length,
                'Cache-Control': 'no-cache',
                'X-Proxy-Status': 'Fallback-Error-Image'
            });
            return res.status(200).send(fallbackBuffer);
        } catch (fallbackErr) {
            return res.status(500).send('Critical Error generating fallback');
        }
    }
}); 

module.exports = app; 
