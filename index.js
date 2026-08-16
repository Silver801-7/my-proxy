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
        return res.status(200).send('v3.9-BrowserSimulator Active');
    } 

    try {
        // **مبدأ المتصفح**: فك الترميز مرة واحدة لتصحيح الـ Double Encoding (مثل تحويل %25 إلى %)
        let targetUrlString = rawUrlParam;
        try {
            targetUrlString = decodeURIComponent(rawUrlParam);
        } catch (e) {
            targetUrlString = rawUrlParam;
        }

        const parsedBase = new URL(targetUrlString);
        const domainOrigin = `${parsedBase.protocol}//${parsedBase.host}`;

        // ترويسات مطابقة تماماً لمتصفح Chrome حقيقي
        const requestHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': domainOrigin + '/',
            'Origin': domainOrigin,
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8'
        };

        if (req.headers['cookie']) {
            requestHeaders['Cookie'] = req.headers['cookie'];
        }

        // إرسال الطلب بالرابط المعالج تماماً كالذي يفتحه المتصفح
        const response = await axiosInstance.get(targetUrlString, { headers: requestHeaders });

        const contentType = (response.headers['content-type'] || '').toLowerCase();
        if (response.status >= 400 || contentType.includes('text/html')) {
            throw new Error(`Invalid Content-Type: ${contentType}`);
        }

        const fileSizeInKB = response.data.length / 1024;
        let pipeline = sharp(response.data, { failOn: 'none', fastShrinkOnLoad: true }).rotate();

        // معالجة الضغط للحفاظ على الوضوح
        if (fileSizeInKB > 700) {
            pipeline = pipeline.resize({
                width: 1200,
                fit: 'inside',
                withoutEnlargement: true
            });
        }

        const compressedBuffer = await pipeline.jpeg({ quality: 40, mozjpeg: true }).toBuffer(); 

        res.set({
            'Content-Type': 'image/jpeg',
            'Content-Length': compressedBuffer.length,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Proxy-Version': '3.9-BrowserSimulator'
        }); 

        return res.status(200).send(compressedBuffer); 

    } catch (err) {
        console.error(`Browser Simulation Failed for [${rawUrlParam}]:`, err.message);
        
        // صورة احتياطية صالحة تماماً لمنع أي خطأ في التطبيق
        try {
            const safeBuffer = await sharp({
                create: { width: 400, height: 300, channels: 3, background: { r: 20, g: 20, b: 20 } }
            }).jpeg().toBuffer();
            
            res.set({ 'Content-Type': 'image/jpeg', 'Content-Length': safeBuffer.length });
            return res.status(200).send(safeBuffer);
        } catch (e) {
            return res.status(500).send('Internal Error');
        }
    }
}); 

module.exports = app;
