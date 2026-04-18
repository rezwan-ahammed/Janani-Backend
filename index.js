const B2 = require('backblaze-b2');
const express = require('express');
const multer = require('multer');
const https = require('https');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

// ১. Firebase Firestore Setup (Project ID: general-57884)
if (!admin.apps.length) {
    admin.initializeApp({
        projectId: "general-57884",
        databaseURL: "https://general-57884-default-rtdb.firebaseio.com"
    });
}
const db = admin.firestore();

const upload = multer({ 
    storage: multer.memoryStorage(), 
    limits: { fileSize: 50 * 1024 * 1024 } 
});

app.use(cors());
app.use(express.json());

const getB2 = async () => {
    const b2 = new B2({
        applicationKeyId: process.env.B2_KEY_ID,
        applicationKey: process.env.B2_APP_KEY
    });
    await b2.authorize();
    return b2;
};

// স্বাস্থ্য পরীক্ষা
app.get('/', (req, res) => {
    res.json({ status: "JANANI_BACKEND_ONLINE", project: "general-57884" });
});

// আপলোড রুট (নামসহ Firestore-এ তথ্য জমা হবে)
app.post('/api/v1/registry/upload', upload.single('file'), async (req, res) => {
    const { studentName } = req.body;
    if (!req.file || !studentName) return res.status(400).json({ error: "ফাইল এবং নাম আবশ্যক" });

    const rawName = req.file.originalname || 'upload';
    const safeName = `pending_${Date.now()}_${rawName.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;

    try {
        const b2 = await getB2();
        const tokenRes = await b2.getUploadUrl({ bucketId: process.env.B2_BUCKET_ID });

        await b2.uploadFile({
            uploadUrl: tokenRes.data.uploadUrl,
            uploadAuthToken: tokenRes.data.authorizationToken,
            fileName: safeName,
            data: req.file.buffer,
            contentLength: req.file.size,
            mime: req.file.mimetype
        });

        // Firestore-এ তথ্য সংরক্ষণ
        await db.collection('janani_media').add({
            fileName: safeName,
            studentName: studentName,
            status: 'pending',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(200).json({ status: "SUCCESS" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// গ্যালারি লিস্ট (Firestore থেকে নামসহ ডেটা আনা)
app.get('/api/v1/registry/list', async (req, res) => {
    const status = req.query.status === 'admin' ? 'pending' : 'approved';
    try {
        const snapshot = await db.collection('janani_media')
            .where('status', '==', status)
            .orderBy('timestamp', 'desc')
            .get();

        const gallery = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                fileName: data.fileName,
                studentName: data.studentName,
                src: `${process.env.BACKEND_URL}/api/v1/media/${encodeURIComponent(data.fileName)}`
            };
        });
        res.status(200).json(gallery);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// অনুমোদন (newFileName ফিক্স সহ)
app.post('/api/v1/registry/approve', async (req, res) => {
    const { id, name } = req.body;
    const approvedName = name.replace('pending_', 'approved_');
    try {
        const b2 = await getB2();
        await b2.copyFile({ sourceFileId: id, newFileName: approvedName });
        await b2.deleteFileVersion({ fileId: id, fileName: name });

        const docs = await db.collection('janani_media').where('fileName', '==', name).get();
        for (const doc of docs.docs) {
            await doc.ref.update({ status: 'approved', fileName: approvedName });
        }
        res.status(200).json({ status: "APPROVED" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ডিলিট রুট
app.delete('/api/v1/registry/delete', async (req, res) => {
    const { id, name } = req.body;
    try {
        const b2 = await getB2();
        await b2.deleteFileVersion({ fileId: id, fileName: name });
        const docs = await db.collection('janani_media').where('fileName', '==', name).get();
        for (const doc of docs.docs) { await doc.ref.delete(); }
        res.status(200).json({ status: "DELETED" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// মিডিয়া প্রক্সি স্ট্রিম
app.get('/api/v1/media/:fileName', async (req, res) => {
    const fileName = decodeURIComponent(req.params.fileName);
    try {
        const b2 = await getB2();
        const dlAuth = await b2.getDownloadAuthorization({
            bucketId: process.env.B2_BUCKET_ID, fileNamePrefix: fileName, validDurationInSeconds: 3600
        });
        const downloadUrl = `${b2.downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${encodeURIComponent(fileName)}?Authorization=${dlAuth.data.authorizationToken}`;
        https.get(downloadUrl, (b2Res) => {
            res.setHeader('Content-Type', b2Res.headers['content-type'] || 'application/octet-stream');
            b2Res.pipe(res);
        });
    } catch (err) { res.status(500).send("Stream error"); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Janani Backend online on ${PORT}`));
