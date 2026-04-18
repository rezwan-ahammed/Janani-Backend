require('dotenv').config();
const express = require('express');
const cors = require('cors');
const B2 = require('backblaze-b2');

const app = express();
app.use(cors());

const b2 = new B2({
  applicationKeyId: process.env.B2_KEY_ID, 
  applicationKey: process.env.B2_APP_KEY
});

// 1. Upload Route (unchanged)
app.get('/api/get-b2-upload-url', async (req, res) => {
  try {
    await b2.authorize(); 
    const response = await b2.getUploadUrl({ bucketId: process.env.B2_BUCKET_ID });
    res.json({
      uploadUrl: response.data.uploadUrl,
      authorizationToken: response.data.authorizationToken
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to get B2 URL" });
  }
});

// 2. NEW Gallery Route (Lists files and generates secure image URLs)
app.get('/api/gallery', async (req, res) => {
  try {
    await b2.authorize();
    
    // Get the list of files in the bucket
    const listResponse = await b2.listFileNames({
      bucketId: process.env.B2_BUCKET_ID,
      maxFileCount: 100 // Fetch up to 100 images
    });

    // Generate a secure 1-hour access token for downloading
    const authResponse = await b2.getDownloadAuthorization({
      bucketId: process.env.B2_BUCKET_ID,
      fileNamePrefix: '', 
      validDurationInSeconds: 3600 
    });

    const bucketName = process.env.B2_BUCKET_NAME;
    const downloadToken = authResponse.data.authorizationToken;

    // Map the files into an array of secure URLs
    const files = listResponse.data.files.map(file => {
      // Backblaze secure download URL format
      const secureUrl = `${b2.downloadUrl}/file/${bucketName}/${encodeURIComponent(file.fileName)}?Authorization=${downloadToken}`;
      return {
        id: file.fileId,
        name: file.fileName,
        url: secureUrl,
        date: new Date(file.uploadTimestamp).toLocaleDateString()
      };
    });

    res.json(files.reverse()); // Reverse to show newest photos first

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load gallery" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
