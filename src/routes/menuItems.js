const express = require('express');
const router = express.Router();

const authenticate = require('../middleware/auth');
const roleGuard = require('../middleware/roleGuard');
const {
  listCategoriesFlat,
  listMenuItems,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
} = require('../controllers/menuController');

// Menu editing is manager-only — separate from whatever endpoint the
// Waiter screen uses to browse the live menu (that one presumably already
// filters to isAvailable items; this one is the management view).
router.use(authenticate);
router.use(roleGuard(['MANAGER']));

router.get('/categories', listCategoriesFlat);
router.get('/', listMenuItems);
router.post('/', createMenuItem);
router.patch('/:id', updateMenuItem);
router.delete('/:id', deleteMenuItem);

module.exports = router;
