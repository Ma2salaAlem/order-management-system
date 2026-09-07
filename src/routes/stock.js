const express = require('express');
const router = express.Router();

const authenticate = require('../middleware/auth');
const roleGuard = require('../middleware/roleGuard');
const {
  listStock,
  listMenuItemsForLinking,
  createStockItem,
  updateStockItem,
  deleteStockItem,
  linkMenuItem,
  unlinkMenuItem,
} = require('../controllers/stockController');

// Stock is manager-only for now — waiters/barista/chef don't need to see
// or edit it, they just cause it to move via orders.
router.use(authenticate);
router.use(roleGuard(['MANAGER']));

router.get('/', listStock);
router.get('/menu-items', listMenuItemsForLinking);
router.post('/', createStockItem);
router.patch('/:id', updateStockItem);
router.delete('/:id', deleteStockItem);

router.post('/:id/links', linkMenuItem);
router.delete('/:id/links/:linkId', unlinkMenuItem);

module.exports = router;
