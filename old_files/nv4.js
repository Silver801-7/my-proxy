const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const http = require('http');
const https = require('https'); 

const app = express(); 

// إعداد عملاء الاتصال مع تفعيل keepAlive وأعلى كفاءة
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ 
    keepAlive: true, 
    maxSockets: 50,
    rejectUnauthorized: false // تجاوز أخطاء SSL لمواقع المانجا
}); 

const axiosInstance = axios.create({
    timeout: 15000, // مهلة 15 ثانية لاستجابة الخوادم البطيئة
    responseType: 'arraybuffer',
    httpAgent,
    httpsAgent,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br'
    }
}); 

// قائمة شمولية موسعة لكشف أنماط ومسميات الأغلفة والصور المصغرة في جميع مصادر المانجا
const COVER_PATTERNS = [
    'cover', 'thumb', 'poster', 'avatar', 'banner', 'front',
    'thumbnail', 'title', 'card', 'preview', 'header', 'series',
    'comic_', 'manga_', 'book_', 'jacket', 'artwork', '_small',
    '_medium', '300x', '250x', '200x', '.thumb.', '-thumb-',
    '/co/', '/c/', '/p/', 'view', 'item', 'cover_url', 'thumbnail_url'
]; 

// إنشاء صورة سوداء بديلة خفيفة (1 كيلوبايت)
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

// الدالة الاحترافية للتحقق مما إذا كان الرابط لغلاف أو صورة مصغرة
function checkIfCover(url) {
    if (!url) return false;
    const lowerUrl = url.toLowerCase();
    return COVER_PATTERNS.some(pattern => lowerUrl.includes(pattern));
} 

app.get('/', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) {
        return res.status(200).send('v1.3-SmartProxy Active');
    } 

    try {
        // 1. جلب الصورة من المصدر الأصلي
        const response = await axiosInstance.get(imageUrl, {
            headers: {
                'Referer': new URL(imageUrl).origin
            }
        }); 

        // 2. الفحص الذكي للرابط وتحديد نوع الصورة
        const isCover = checkIfCover(imageUrl); 

        // طباعة التتبع في السجلات لسهولة الفحص
        console.log(`[${isCover ? 'غلاف COVER' : 'فصل CHAPTER'}]: ${imageUrl}`); 

        let targetWidth;
        let quality; 

        if (isCover) {
            // معالجة الأغلفة والصور المصغرة: جودة 20% وأبعاد مخصصة لبطاقة المانجا
            targetWidth = 280; 
            quality = 20;     
        } else {
            // معالجة صفحات الفصول بناءً على المعلمات أو القيمة الافتراضية
            const rawQuality = req.query.q || req.query.quality || req.query.l || req.headers['x-image-quality'];
            quality = rawQuality ? parseInt(rawQuality, 10) : 40;
            if (isNaN(quality)) quality = 40;
            quality = Math.max(1, Math.min(100, quality)); 

            targetWidth = Math.round(450 + (quality / 100) * 900);
        } 

        const isGrayscale = req.query.bw === '1' || req.query.bw === 'true' || req.query.grayscale === '1'; 

        // 3. بناء خط المعالجة الضوئي (Sharp Processing Pipeline)
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
            'X-Proxy-Version': '1.3-SmartProxy',
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
