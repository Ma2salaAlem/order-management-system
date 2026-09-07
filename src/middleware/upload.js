const fs = require('fs');
const path = require('path');
const multer = require('multer');

// Screenshots land in public/uploads/payment-screenshots/ — since app.js
// already serves the whole public/ folder statically, anything saved here
// is instantly reachable at /uploads/payment-screenshots/<filename> with
// no extra route needed.
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'payment-screenshots');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, unique);
  },
});

const fileFilter = (req, file, cb) => {
  if (!file.mimetype.startsWith('image/')) {
    return cb(new Error('Only image files are allowed for payment screenshots'));
  }
  cb(null, true);
};

const uploadPaymentScreenshot = multer({
  storage,
  fileFilter,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB — plenty for a phone screenshot
});

module.exports = { uploadPaymentScreenshot };
