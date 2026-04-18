const B2 = require('backblaze-b2');
const express = require('express');
const multer = require('multer');
const https = require('https');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

// ১. Firebase Firestore Setup (google-services.json থেকে তথ্য নেওয়া হয়েছে)
// নোট: Render-এ আপনার Service Account JSON-টি এনভায়রনমেন্ট ভেরিয়েবল হিসেবে সেট করা ভালো।
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

// 🚀 ৫. প্রক্সি আপলোড + Firestore-এ নাম সংরক্ষণ
app.post('/api/v1/registry/upload', upload.single('file'), async (req, res) => {
    const { studentName } = req.body; // ফ্রন্টেন্ড থেকে পাঠানো নাম
    if (!req.file || !studentName) return res.status(400).json({ error: "ফাইল এবং নাম দুটোই প্রয়োজন" });

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

        // Firestore-এ এন্ট্রি তৈরি করা
        await db.collection('janani_media').add({
            fileName: safeName,
            studentName: studentName,
            status: 'pending',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(200).json({ status: "UPLOAD_SUCCESS" });
    } catch (err) {
        console.error('Upload Error:', err.message);
        res.status(500).json({ error: "UPLOAD_FAILED", details: err.message });
    }
});

// 📁 ৬. গ্যালারি লিস্ট (Firestore থেকে নামসহ ডাটা আনা)
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
        res.status(500).json({ error: "LIST_FAILED", details: err.message });
    }
});

// ✅ ৮. অনুমোদন (Firestore স্ট্যাটাস আপডেট)
app.post('/api/v1/registry/approve', async (req, res) => {
    const { id, name } = req.body;
    const approvedName = name.replace('pending_', 'approved_');
    try {
        const b2 = await getB2();
        await b2.copyFile({ sourceFileId: id, newFileName: approvedName });
        await b2.deleteFileVersion({ fileId: id, fileName: name });

        // Firestore আপডেট (ID দিয়ে সরাসরি আপডেট)
        const docs = await db.collection('janani_media').where('fileName', '==', name).get();
        const updatePromises = docs.docs.map(doc => doc.ref.update({ 
            status: 'approved',
            fileName: approvedName 
        }));
        await Promise.all(updatePromises);

        res.status(200).json({ status: "APPROVED" });
    } catch (err) {
        res.status(500).json({ error: "APPROVAL_FAILED", details: err.message });
    }
});

// 🗑️ ৯. ডিলিট (Firestore থেকে মুছে ফেলা)
app.delete('/api/v1/registry/delete', async (req, res) => {
    const { name } = req.body;
    try {
        const b2 = await getB2();
        // ফাইলটি খুঁজে বের করা এবং ডিলিট করা
        const list = await b2.listFileNames({ bucketId: process.env.B2_BUCKET_ID, prefix: name, maxFileCount: 1 });
        if (list.data.files.length > 0) {
            await b2.deleteFileVersion({ fileId: list.data.files[0].fileId, fileName: name });
        }

        const docs = await db.collection('janani_media').where('fileName', '==', name).get();
        const deletePromises = docs.docs.map(doc => doc.ref.delete());
        await Promise.all(deletePromises);

        res.status(200).json({ status: "DELETED" });
    } catch (err) {
        res.status(500).json({ error: "DELETE_FAILED", details: err.message });
    }
});

// মিডিয়া প্রক্সি স্ট্রিম (আগের মতোই)
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
            res.pipe(res);
        });
    } catch (err) { res.status(500).send("Proxy error"); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend online on ${PORT}`));
