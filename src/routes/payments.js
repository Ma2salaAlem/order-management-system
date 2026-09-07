const express = require('express');
const router = express.Router();

const authenticate = require('../middleware/auth');
const roleGuard = require('../middleware/roleGuard');
const { uploadPaymentScreenshot } = require('../middleware/upload');
const { listUnpaidOrders, listPaymentHistory, payOrders } = require('../controllers/paymentController');

router.use(authenticate);
router.use(roleGuard(['CASHIER', 'MANAGER']));

router.get('/unpaid', listUnpaidOrders);
router.get('/history', listPaymentHistory);
router.post('/', uploadPaymentScreenshot.single('screenshot'), payOrders);

module.exports = router;
