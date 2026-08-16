const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const http = require('http');
const https = require('https'); 

const app = express(); 

// ضبط وكلاء الاتصال لدعم السرعة والثبات العالي وتجنب قطع الـ Socket
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ 
    keepAlive: true, 
    maxSockets: 100,
    rejectUnauthorized: false,
    secureProtocol: 'TLSv1_2_method'
}); 

const axiosInstance = axios.create({
    timeout: 20000, 
    maxRedirects: 10,
    responseType: 'arraybuffer',
    httpAgent,
    httpsAgent
}); 

app.get('/', async (req, res) => {
    const rawUrlParam = req.query.url;
    if (!rawUrlParam) {
        return res.status(200).send('v4.1-DirectProxy Active');
    } 

    let targetUrlString = rawUrlParam;
    try {
        targetUrlString = decodeURIComponent(rawUrlParam);
    } catch (e) {
        targetUrlString = rawUrlParam;
    }

    try {
        const parsedBase = new URL(targetUrlString);
        const domainOrigin = `${parsedBase.protocol}//${parsedBase.host}`;

        // هيدرز دقيقة تحاكي متصفح فايرفوكس أو كروم لمنع حظر الـ CDN
        const requestHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
            'Accept': 'image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': domainOrigin + '/',
            'Sec-Fetch-Dest': 'image',
            'Sec-Fetch-Mode': 'no-cors',
            'Sec-Fetch-Site': 'cross-site',
            'Connection': 'keep-alive'
        };

        if (req.headers['cookie']) {
            requestHeaders['Cookie'] = req.headers['cookie'];
        }

        // جلب الصورة مباشرة دون استثناءات
        const response = await axiosInstance.get(targetUrlString, { headers: requestHeaders });

        const contentType = (response.headers['content-type'] || '').toLowerCase();
        if (response.status >= 400 || contentType.includes('text/html')) {
            throw new Error(`Blocked or Invalid Content: ${response.status}`);
        }

        const fileSizeInKB = response.data.length / 1024;
        let pipeline = sharp(response.data, { failOn: 'none', fastShrinkOnLoad: true }).rotate();

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
            'X-Proxy-Version': '4.1-DirectProxy'
        }); 

        return res.status(200).send(compressedBuffer); 

    } catch (err) {
        console.error(`Proxy Fetch Error for [${targetUrlString}]:`, err.message);
        return res.status(500).send(`Proxy Error: ${err.message}`);
    }
}); 

module.exports = app;
