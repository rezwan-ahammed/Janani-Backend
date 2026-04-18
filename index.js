const B2 = require('backblaze-b2');
const express = require('express');
const https = require('https');
const cors = require('cors');

const app = express();

// CORS to allow your frontend to talk to this backend
app.use(cors());
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());

// Re-authorize function for safety on free tiers
const getB2 = async () => {
    const b2 = new B2({
        applicationKeyId: process.env.B2_KEY_ID,
        applicationKey: process.env.B2_APP_KEY
    });
    await b2.authorize();
    return b2;
};

// Health Check (Use this URL to wake up Render)
app.get('/', (req, res) => {
    res.json({ status: "JCC_BACKEND_ONLINE", time: new Date().toISOString() });
});

// 1. Get Token for Uploads
app.get('/api/v1/auth/upload-token', async (req, res) => {
    try {
        const b2 = await getB2();
        const response = await b2.getUploadUrl({ bucketId: process.env.B2_BUCKET_ID });
        res.status(200).json({
            uploadUrl: response.data.uploadUrl,
            authorizationToken: response.data.authorizationToken
        });
    } catch (err) {
        res.status(500).json({ error: "B2_AUTH_FAILED", details: err.message });
    }
});

// 2. List Files (Generates safe proxy URLs)
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
        res.status(500).json({ error: "REGISTRY_FETCH_FAILED", details: err.message });
    }
});

// 3. Proxy Media Stream (Safely streams private files to the frontend)
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
        }).on('error', (e) => {
            res.status(500).json({ error: "PROXY_FAILED" });
        });
    } catch (err) {
        res.status(500).json({ error: "MEDIA_FETCH_FAILED", details: err.message });
    }
});

// 4. Approve File
app.post('/api/v1/registry/approve', async (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) return res.status(400).json({ error: "MISSING_PARAMS" });
    const approvedName = name.replace('pending_', 'approved_');
    try {
        const b2 = await getB2();
        await b2.copyFile({ sourceFileId: id, fileName: approvedName });
        await b2.deleteFileVersion({ fileId: id, fileName: name });
        res.status(200).json({ status: "APPROVED", newName: approvedName });
    } catch (err) {
        res.status(500).json({ error: "APPROVAL_FAILED", details: err.message });
    }
});

// 5. Delete File
app.delete('/api/v1/registry/delete', async (req, res) => {
    const { id, name } = req.body;
    if (!id || !name) return res.status(400).json({ error: "MISSING_PARAMS" });
    try {
        const b2 = await getB2();
        await b2.deleteFileVersion({ fileId: id, fileName: name });
        res.status(200).json({ status: "DELETED" });
    } catch (err) {
        res.status(500).json({ error: "DELETE_FAILED", details: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`JCC Backend online on port ${PORT}`));
