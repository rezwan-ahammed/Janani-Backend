const B2 = require('backblaze-b2');
const express = require('express');
const multer = require('multer');
const https = require('https');
const cors = require('cors');

const app = express();

// 1. Storage Configuration (Multer handles mobile binary chunks perfectly)
const upload = multer({ 
    storage: multer.memoryStorage(), 
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB Max
});

// 2. Middleware & CORS
app.use(cors());
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json());

// 3. Backblaze Helper Function
const getB2 = async () => {
    const b2 = new B2({
        applicationKeyId: process.env.B2_KEY_ID,
        applicationKey: process.env.B2_APP_KEY
    });
    await b2.authorize();
    return b2;
};

// 4. Health Check
app.get('/', (req, res) => {
    res.json({ status: "JCC_BACKEND_ONLINE", timestamp: new Date().toISOString() });
});

// 🚀 5. Proxy Upload (Bypasses Browser CORS)
app.post('/api/v1/registry/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "NO_FILE_RECEIVED" });

    const rawName = req.file.originalname || 'upload';
    const safeName = `pending_${Date.now()}_${rawName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;

    try {
        const b2 = await getB2();
        const tokenRes = await b2.getUploadUrl({ bucketId: process.env.B2_BUCKET_ID });

        await b2.uploadFile({
            uploadUrl: tokenRes.data.uploadUrl,
            uploadAuthToken: tokenRes.data.authorizationToken,
            fileName: safeName,
            data: req.file.buffer,           // Multer buffer
            contentLength: req.file.size,    // Mandatory for B2
            mime: req.file.mimetype
        });

        res.status(200).json({ status: "UPLOAD_SUCCESS", fileName: safeName });
    } catch (err) {
        console.error('Upload Error:', err.message);
        res.status(500).json({ error: "UPLOAD_FAILED", details: err.message });
    }
});

// 📁 6. List Files (Pending or Approved)
app.get('/api/v1/registry/list', async (req, res) => {
    const prefix = req.query.status === 'admin' ? 'pending_' : 'approved_';
    try {
        const b2 = await getB2();
        const list = await b2.listFileNames({
            bucketId: process.env.B2_BUCKET_ID,
            prefix: prefix,
            maxFileCount: 500
        });

        const gallery = list.data.files.map(f => ({
            fileId: f.fileId,
            fileName: f.fileName,
            src: `${process.env.BACKEND_URL}/api/v1/media/${encodeURIComponent(f.fileName)}`
        }));

        res.status(200).json(gallery);
    } catch (err) {
        res.status(500).json({ error: "LIST_FAILED", details: err.message });
    }
});

// 📺 7. Media Proxy Stream (Views Private Files)
app.get('/api/v1/media/:fileName', async (req, res) => {
    const fileName = decodeURIComponent(req.params.fileName);
    try {
        const b2 = await getB2();
        const dlAuth = await b2.getDownloadAuthorization({
            bucketId: process.env.B2_BUCKET_ID,
            fileNamePrefix: fileName,
            validDurationInSeconds: 3600
        });

        const downloadUrl = `${b2.downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${encodeURIComponent(fileName)}?Authorization=${dlAuth.data.authorizationToken}`;

        https.get(downloadUrl, (b2Res) => {
            res.setHeader('Content-Type', b2Res.headers['content-type'] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            b2Res.pipe(res);
        }).on('error', () => res.status(500).json({ error: "STREAM_FAILED" }));

    } catch (err) {
        res.status(500).json({ error: "PROXY_FAILED", details: err.message });
    }
});

// ✅ 8. Approve File (Rename pending_ to approved_)
app.post('/api/v1/registry/approve', async (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) return res.status(400).json({ error: "MISSING_PARAMS" });
    
    const approvedName = name.replace('pending_', 'approved_');
    try {
        const b2 = await getB2();
        
        // 🔥 FIXED PARAMETER: Must use newFileName
        await b2.copyFile({ 
            sourceFileId: id, 
            newFileName: approvedName 
        });

        await b2.deleteFileVersion({ fileId: id, fileName: name });
        res.status(200).json({ status: "APPROVED" });
    } catch (err) {
        console.error('Approve Error:', err.message);
        res.status(500).json({ error: "APPROVAL_FAILED", details: err.message });
    }
});

// 🗑️ 9. Delete File
app.delete('/api/v1/registry/delete', async (req, res) => {
    const { id, name } = req.body;
    try {
        const b2 = await getB2();
        await b2.deleteFileVersion({ fileId: id, fileName: name });
        res.status(200).json({ status: "DELETED" });
    } catch (err) {
        res.status(500).json({ error: "DELETE_FAILED", details: err.message });
    }
});

// 🪄 10. Magic CORS Fix Route
app.get('/api/v1/fix-cors', async (req, res) => {
    try {
        const b2 = await getB2();
        await b2.updateBucket({
            bucketId: process.env.B2_BUCKET_ID,
            bucketType: 'allPrivate',
            corsRules: [{
                corsRuleName: 'allowBrowserUploads',
                allowedOrigins: ['*'],
                allowedOperations: ['b2_upload_file', 'b2_download_file_by_name'],
                allowedHeaders: ['*'],
                exposeHeaders: ['x-bz-file-name', 'x-bz-content-sha1'],
                maxAgeSeconds: 3600
            }]
        });
        res.send("✅ MAGIC FIX: CORS rules updated successfully!");
    } catch (err) {
        res.send("❌ Error: " + err.message);
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`JCC Backend online on port ${PORT}`));
