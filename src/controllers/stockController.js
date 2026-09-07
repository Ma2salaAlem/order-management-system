const prisma = require('../prisma/client');

// GET /api/stock — every stock item, with which menu items it's linked to
// (and how much each sale consumes). Manager only.
async function listStock(req, res) {
  try {
    const items = await prisma.stockItem.findMany({
      include: { links: { include: { menuItem: true } } },
      orderBy: { name: 'asc' },
    });
    return res.json(items);
  } catch (err) {
    console.error('listStock error:', err);
    return res.status(500).json({ error: 'Failed to fetch stock' });
  }
}

// GET /api/stock/menu-items — a flat list of menu items for the "link this
// stock item to a menu item" picker on the dashboard. Deliberately its own
// lightweight endpoint rather than reusing /api/categories, so this stays
// self-contained and doesn't depend on that route's role rules.
async function listMenuItemsForLinking(req, res) {
  try {
    const items = await prisma.menuItem.findMany({
      select: { id: true, name: true, category: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });
    return res.json(items);
  } catch (err) {
    console.error('listMenuItemsForLinking error:', err);
    return res.status(500).json({ error: 'Failed to fetch menu items' });
  }
}

// POST /api/stock
async function createStockItem(req, res) {
  const { name, category, quantity, unit, threshold } = req.body;

  if (!name || !category || quantity === undefined || quantity === null) {
    return res.status(400).json({ error: 'name, category, and quantity are required' });
  }
  if (Number.isNaN(Number(quantity)) || Number(quantity) < 0) {
    return res.status(400).json({ error: 'quantity must be a non-negative number' });
  }

  try {
    const item = await prisma.stockItem.create({
      data: {
        name,
        category,
        quantity: Number(quantity),
        unit: unit || null,
        threshold: threshold === undefined || threshold === null || threshold === '' ? null : Number(threshold),
      },
      include: { links: { include: { menuItem: true } } },
    });
    return res.status(201).json(item);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A stock item with that name already exists' });
    }
    console.error('createStockItem error:', err);
    return res.status(500).json({ error: 'Failed to create stock item' });
  }
}

// PATCH /api/stock/:id — used both for full edits (name/category/unit/
// threshold) and for the quick "Save" quantity update on the dashboard.
async function updateStockItem(req, res) {
  const { id } = req.params;
  const { name, category, quantity, unit, threshold } = req.body;

  const data = {};
  if (name !== undefined) data.name = name;
  if (category !== undefined) data.category = category;
  if (unit !== undefined) data.unit = unit || null;
  if (threshold !== undefined) data.threshold = threshold === null || threshold === '' ? null : Number(threshold);
  if (quantity !== undefined) {
    if (Number.isNaN(Number(quantity)) || Number(quantity) < 0) {
      return res.status(400).json({ error: 'quantity must be a non-negative number' });
    }
    data.quantity = Number(quantity);
  }

  try {
    const item = await prisma.stockItem.update({
      where: { id },
      data,
      include: { links: { include: { menuItem: true } } },
    });
    return res.json(item);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Stock item not found' });
    if (err.code === 'P2002') return res.status(409).json({ error: 'A stock item with that name already exists' });
    console.error('updateStockItem error:', err);
    return res.status(500).json({ error: 'Failed to update stock item' });
  }
}

// DELETE /api/stock/:id
async function deleteStockItem(req, res) {
  const { id } = req.params;
  try {
    await prisma.stockItem.delete({ where: { id } });
    return res.status(204).send();
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Stock item not found' });
    console.error('deleteStockItem error:', err);
    return res.status(500).json({ error: 'Failed to delete stock item' });
  }
}

// POST /api/stock/:id/links — link a menu item to this stock item, with how
// much one sale of that menu item consumes. Upserts so re-linking the same
// menu item just updates the qtyPerSale instead of erroring.
async function linkMenuItem(req, res) {
  const { id } = req.params; // stockItemId
  const { menuItemId, qtyPerSale } = req.body;

  if (!menuItemId) {
    return res.status(400).json({ error: 'menuItemId is required' });
  }
  const qty = qtyPerSale === undefined || qtyPerSale === null || qtyPerSale === '' ? 1 : Number(qtyPerSale);
  if (Number.isNaN(qty) || qty <= 0) {
    return res.status(400).json({ error: 'qtyPerSale must be a positive number' });
  }

  try {
    const link = await prisma.menuItemStock.upsert({
      where: { menuItemId_stockItemId: { menuItemId, stockItemId: id } },
      update: { qtyPerSale: qty },
      create: { menuItemId, stockItemId: id, qtyPerSale: qty },
      include: { menuItem: true },
    });
    return res.status(201).json(link);
  } catch (err) {
    if (err.code === 'P2003') return res.status(400).json({ error: 'Invalid menuItemId' });
    console.error('linkMenuItem error:', err);
    return res.status(500).json({ error: 'Failed to link menu item' });
  }
}

// DELETE /api/stock/:id/links/:linkId
async function unlinkMenuItem(req, res) {
  const { linkId } = req.params;
  try {
    await prisma.menuItemStock.delete({ where: { id: linkId } });
    return res.status(204).send();
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Link not found' });
    console.error('unlinkMenuItem error:', err);
    return res.status(500).json({ error: 'Failed to remove link' });
  }
}

module.exports = {
  listStock,
  listMenuItemsForLinking,
  createStockItem,
  updateStockItem,
  deleteStockItem,
  linkMenuItem,
  unlinkMenuItem,
};
