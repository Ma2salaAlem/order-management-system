const express = require('express');
const router = express.Router();

const authenticate = require('../middleware/auth');
const roleGuard = require('../middleware/roleGuard');
const { auditAttempt } = require('../middleware/auditLogger');
const {
  createOrder,
  updateOrderStatus,
  voidOrder,
  listActiveOrders,
  listMyOrders,
  listAllOrdersForDay,
  listCompletedToday,
} = require('../controllers/orderController');

// Every order route requires a valid, authenticated user
router.use(authenticate);

// Barista/Chef Display — active queue. Both displays receive every order
// and filter client-side to the items relevant to them (drinks vs food).
router.get('/', roleGuard(['BARISTA', 'CHEF', 'MANAGER']), listActiveOrders);

// Barista/Chef Display — today's completed orders (or a picked date), so
// "Recent Completed" is still populated after a page refresh
router.get('/completed', roleGuard(['BARISTA', 'CHEF', 'MANAGER']), listCompletedToday);

// Waiter screen — that waiter's own orders (for a given day)
router.get('/mine', roleGuard(['WAITER']), listMyOrders);

// Manager dashboard — every order for a given day, any status
router.get('/all', roleGuard(['MANAGER']), listAllOrdersForDay);

// Waiter submits an order
router.post('/', roleGuard(['WAITER']), createOrder);

// Barista/Chef/manager updates status — logged regardless of who calls it.
// NOTE: status lives on the whole order, not per item — if a single order
// mixes food and drink items, marking it complete on one display marks it
// complete for both. Splitting status per item would need a bigger change;
// flagging this now in case it matters for how you use these two screens.
router.patch(
  '/:id/status',
  auditAttempt('ORDER_STATUS_CHANGE'),
  roleGuard(['BARISTA', 'CHEF', 'MANAGER']),
  updateOrderStatus
);

// Security-critical: only MANAGER can void/cancel an order. The audit
// middleware runs FIRST — a waiter's forbidden attempt still lands in
// AuditLog with success: false, before roleGuard ever returns the 403.
router.delete(
  '/:id',
  auditAttempt('ORDER_DELETE_ATTEMPT'),
  roleGuard(['MANAGER']),
  voidOrder
);

module.exports = router;
