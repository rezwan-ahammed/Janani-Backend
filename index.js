const B2 = require('backblaze-b2');
const express = require('express');
const multer = require('multer');
const https = require('https');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB max

// CORS
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());

const getB2 = async () => {
    const b2 = new B2({
        applicationKeyId: process.env.B2_KEY_ID,
        applicationKey: process.env.B2_APP_KEY
    });
    await b2.authorize();
    return b2;
};

// Health check
app.get('/', (req, res) => {
    res.json({ status: "JCC_BACKEND_ONLINE", time: new Date().toISOString() });
});

// ── Route 1: PROXY UPLOAD (multer handles mobile binary correctly) ──────────
app.post('/api/v1/registry/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "NO_FILE_RECEIVED" });
    }

    const rawName = req.file.originalname || 'upload';
    const safeName = `pending_${Date.now()}_${rawName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;

    try {
        const b2 = await getB2();
        const tokenRes = await b2.getUploadUrl({ bucketId: process.env.B2_BUCKET_ID });

        await b2.uploadFile({
            uploadUrl: tokenRes.data.uploadUrl,
            uploadAuthToken: tokenRes.data.authorizationToken,
            fileName: safeName,
            data: req.file.buffer,           // ✅ multer gives a proper Buffer
            contentLength: req.file.size,    // ✅ B2 needs exact size
            mime: req.file.mimetype
        });

        res.status(200).json({ status: "UPLOAD_SUCCESS", fileName: safeName });
    } catch (err) {
        console.error('upload error:', err.message);
        res.status(500).json({ error: "UPLOAD_FAILED", details: err.message });
    }
});

// ── Route 2: List files ─────────────────────────────────────────────────────
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
        console.error('list error:', err.message);
        res.status(500).json({ error: "REGISTRY_FETCH_FAILED", details: err.message });
    }
});

// ── Route 3: Stream/proxy a private file from B2 ───────────────────────────
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
        }).on('error', () => res.status(500).json({ error: "PROXY_FAILED" }));

    } catch (err) {
        console.error('media error:', err.message);
        res.status(500).json({ error: "MEDIA_FETCH_FAILED", details: err.message });
    }
});

// ── Route 4: Approve file ───────────────────────────────────────────────────
app.post('/api/v1/registry/approve', async (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) return res.status(400).json({ error: "MISSING_PARAMS" });
    const approvedName = name.replace('pending_', 'approved_');
    try {
        const b2 = await getB2();
        await b2.copyFile({ sourceFileId: id, fileName: approvedName });
        await b2.deleteFileVersion({ fileId: id, fileName: name });
        res.status(200).json({ status: "APPROVED" });
    } catch (err) {
        console.error('approve error:', err.message);
        res.status(500).json({ error: "APPROVAL_FAILED", details: err.message });
    }
});

// ── Route 5: Delete file ────────────────────────────────────────────────────
app.delete('/api/v1/registry/delete', async (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) return res.status(400).json({ error: "MISSING_PARAMS" });
    try {
        const b2 = await getB2();
        await b2.deleteFileVersion({ fileId: id, fileName: name });
        res.status(200).json({ status: "DELETED" });
    } catch (err) {
        console.error('delete error:', err.message);
        res.status(500).json({ error: "DELETE_FAILED", details: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`JCC Backend online on port ${PORT}`));
