const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();


const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  },
});


const ALLOWED_MIME_PREFIXES = ['image/', 'video/'];
const ALLOWED_DOCUMENT_MIMES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'application/zip',
  'application/octet-stream', 
];

function fileFilter(req, file, cb) {
  const isAllowedPrefix = ALLOWED_MIME_PREFIXES.some(prefix => file.mimetype.startsWith(prefix));
  const isAllowedDocument = ALLOWED_DOCUMENT_MIMES.includes(file.mimetype);

  if (isAllowedPrefix || isAllowedDocument) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type: ${file.mimetype}`));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 200 * 1024 * 1024, //maximumm size allowed is 200mbs for a file
  },
});


router.post('/file', upload.single('file'), (req, res) => {   
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  
  const fileUrl = `/uploads/${req.file.filename}`;

  res.json({ fileUrl });
});


router.use((err, req, res, next) => {
  if (err) {
    console.error('Upload error:', err.message);
    return res.status(400).json({ error: err.message });
  }
  next();
});

module.exports = router;