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

async function createPlaceholder() {
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
    // استخراج الرابط الخام مباشرة من مسار الطلب لتجنب فك الترميز المزدوج (%25) بواسطة Express
    const match = req.url.match(/[?&]url=([^&]*)/);
    if (!match || !match[1]) {
        return res.status(200).send('v3.7-SmartProxy Active (Raw URL Engine)');
    } 

    // فك الترميز لمرة واحدة فقط للحصول على الرابط الأصلي بدقة متناهية
    const targetUrlString = decodeURIComponent(match[1]);

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
            // محاولة جلب مباشرة بالرابط الخام في حال فشل البروكسي الأول
            response = await axios.get(targetUrlString, { 
                responseType: 'arraybuffer',
                headers: { 'User-Agent': requestHeaders['User-Agent'], 'Referer': domainOrigin + '/' }
            });
        }

        const contentType = (response.headers['content-type'] || '').toLowerCase();
        if (response.status >= 400 || contentType.includes('text/html')) {
            throw new Error('Invalid Content or Status');
        }

        let pipeline = sharp(response.data, { failOn: 'none', fastShrinkOnLoad: true }).rotate();
        
        const fileSizeInKB = response.data.length / 1024;
        let quality = 40;
        const rawQ = req.url.match(/[?&](?:q|quality|l)=([^&]*)/);
        if (rawQ && rawQ[1]) {
            const parsedQ = parseInt(decodeURIComponent(rawQ[1]), 10);
            if (!isNaN(parsedQ)) quality = Math.max(1, Math.min(100, parsedQ));
        }

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
            'X-Proxy-Version': '3.7-RawEngine'
        }); 

        return res.status(200).send(compressedBuffer); 

    } catch (err) {
        console.error(`Failed to fetch image: ${targetUrlString}`, err.message);
        try {
            // محاولة أخيرة مرنة لجلب الصورة الأصلية دون ضغط لتفادي أي خطأ نهائي
            const directFallback = await axios.get(targetUrlString, { responseType: 'arraybuffer' });
            res.set('Content-Type', 'image/jpeg');
            return res.status(200).send(directFallback.data);
        } catch (finalErr) {
            const safeBuffer = await createPlaceholder();
            res.set({ 'Content-Type': 'image/jpeg', 'Content-Length': safeBuffer.length });
            return res.status(200).send(safeBuffer);
        }
    }
}); 

module.exports = app;
