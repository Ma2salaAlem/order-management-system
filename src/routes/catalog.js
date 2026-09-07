const express = require('express');
const router = express.Router();

const authenticate = require('../middleware/auth');
const prisma = require('../prisma/client');

router.use(authenticate);

// GET /api/tables
router.get('/tables', async (req, res) => {
  try {
    const tables = await prisma.restaurantTable.findMany({ orderBy: { label: 'asc' } });
    res.json(tables);
  } catch (err) {
    console.error('list tables error:', err);
    res.status(500).json({ error: 'Failed to fetch tables' });
  }
});

// GET /api/categories — top-level categories, each with its own available
// menu items AND (if any) its child categories, each with their own items.
// A category like "Snacks" has items directly and no children. A category
// like "Drinks" has no items directly and instead has children ("Hot
// Drinks", "Alcohol", etc.) that hold the actual items.
router.get('/categories', async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      where: { parentId: null },
      include: {
        menuItems: { where: { isAvailable: true }, orderBy: { name: 'asc' } },
        children: {
          include: {
            menuItems: { where: { isAvailable: true }, orderBy: { name: 'asc' } },
            // One further level — e.g. "Alcohol" (a child of "Drinks") has its
            // own children like "Red Wine", "Whisky", etc.
            children: {
              include: {
                menuItems: { where: { isAvailable: true }, orderBy: { name: 'asc' } },
              },
              orderBy: { name: 'asc' },
            },
          },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });
    res.json(categories);
  } catch (err) {
    console.error('list categories error:', err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

module.exports = router;
