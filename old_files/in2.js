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
            background: { r: 15, g: 15, b: 15 }
        }
    })
    .jpeg({ quality: 10 })
    .toBuffer();
} 

function checkIfCover(url) {
    if (!url) return false;
    const lowerUrl = url.toLowerCase();
    return COVER_PATTERNS.some(pattern => lowerUrl.includes(pattern));
} 

app.get('/', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) {
        return res.status(200).send('v1.5-SmartProxy Active');
    } 

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
            throw new Error(`Invalid response status: ${response.status} or content-type: ${contentType}`);
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

        if (isGrayscale && !isCover) {
            pipeline = pipeline.grayscale();
        } 

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
            'X-Proxy-Version': '1.5-SmartProxy',
            'X-Image-Type': isCover ? 'Cover' : 'Chapter'
        }); 

        return res.status(200).send(compressedBuffer); 

    } catch (err) {
        console.error(`Image Fetch Error [${imageUrl}]:`, err.message); 

        try {
            const fallbackBuffer = await getFallbackImage();
            res.set({
                'Content-Type': 'image/jpeg',
                'Content-Length': fallbackBuffer.length,
                'Cache-Control': 'public, max-age=86400',
                'X-Proxy-Status': 'Fallback-Image'
            });
            return res.status(200).send(fallbackBuffer);
        } catch (fallbackErr) {
            return res.status(500).send('Critical Error');
        }
    }
}); 

module.exports = app;
