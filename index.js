const B2 = require('backblaze-b2');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const b2 = new B2({
  applicationKeyId: process.env.B2_KEY_ID, 
  applicationKey: process.env.B2_APP_KEY
});

// Helper: Authorize B2
const initB2 = async () => { await b2.authorize(); };

// 1. Get Upload URL
app.get('/api/get-b2-upload-url', async (req, res) => {
  try {
    await initB2();
    const response = await b2.getUploadUrl({ bucketId: process.env.B2_BUCKET_ID });
    res.json(response.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. List Files for Gallery/Admin
app.get('/api/list-files', async (req, res) => {
  const mode = req.query.mode; // 'approved' or 'pending'
  try {
    await initB2();
    const list = await b2.listFileNames({
      bucketId: process.env.B2_BUCKET_ID,
      maxFileCount: 1000,
      prefix: mode === 'admin' ? 'pending_' : 'approved_'
    });
    
    const files = list.data.files.map(f => ({
      id: f.fileId,
      name: f.fileName,
      url: `https://f000.backblazeb2.com/file/${process.env.B2_BUCKET_NAME}/${f.fileName}`
    }));
    res.json(files);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Admin: Approve (Rename file)
app.post('/api/approve-file', async (req, res) => {
  const { fileId, fileName } = req.body;
  const newName = fileName.replace('pending_', 'approved_');
  try {
    await initB2();
    // B2 renames by copying then deleting
    await b2.copyFile({
      sourceFileId: fileId,
      destinationFileName: newName,
      metadataDirective: 'COPY'
    });
    await b2.deleteFileVersion({ fileId: fileId, fileName: fileName });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`JCC Backend Active on ${PORT}`));
