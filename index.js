require('dotenv').config(); // Allows local testing if you use a .env file later
const express = require('express');
const cors = require('cors');
const B2 = require('backblaze-b2');

const app = express();

// Enable CORS so your React HTML file is allowed to talk to this server
app.use(cors());

// Initialize the Backblaze client using environment variables
const b2 = new B2({
  applicationKeyId: process.env.B2_KEY_ID, 
  applicationKey: process.env.B2_APP_KEY
});

// The endpoint your React frontend will call
app.get('/api/get-b2-upload-url', async (req, res) => {
  try {
    // 1. Authorize the connection with Backblaze
    await b2.authorize(); 
    
    // 2. Request an upload URL for your specific bucket
    const response = await b2.getUploadUrl({
      bucketId: process.env.B2_BUCKET_ID 
    });
    
    // 3. Send the generated URL and authorization token back to the frontend
    res.json({
      uploadUrl: response.data.uploadUrl,
      authorizationToken: response.data.authorizationToken
    });

  } catch (error) {
    console.error("Backblaze Error:", error);
    res.status(500).json({ error: "Failed to get secure upload URL from Backblaze" });
  }
});

// Use the port Render assigns, or default to 3000 for local testing
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend server is successfully running on port ${PORT}`);
});
