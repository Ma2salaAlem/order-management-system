const prisma = require('../prisma/client');

// Builds a readable "Drinks > Alcohol > Red Wine" style path for a
// category, walking up to two levels of parent (matches the app's
// existing one-level-of-nesting-under-a-nested-thing structure).
function categoryPath(cat) {
  const parts = [cat.name];
  let c = cat;
  while (c.parent) {
    parts.unshift(c.parent.name);
    c = c.parent;
  }
  return parts.join(' > ');
}

// GET /api/menu-items/categories — flat list for the "Category" picker on
// the Menu tab's add/edit form. Manager only.
async function listCategoriesFlat(req, res) {
  try {
    const categories = await prisma.category.findMany({
      include: { parent: { include: { parent: true } } },
      orderBy: { name: 'asc' },
    });
    const flat = categories.map((c) => ({ id: c.id, path: categoryPath(c) })).sort((a, b) => a.path.localeCompare(b.path));
    return res.json(flat);
  } catch (err) {
    console.error('listCategoriesFlat error:', err);
    return res.status(500).json({ error: 'Failed to fetch categories' });
  }
}

// GET /api/menu-items — every menu item, available or not, for the
// manager's own editing table (the waiter's own /api/categories endpoint
// presumably already filters to isAvailable — this one deliberately
// doesn't, since a manager needs to see and re-enable hidden items too).
async function listMenuItems(req, res) {
  try {
    const items = await prisma.menuItem.findMany({
      include: { category: { include: { parent: { include: { parent: true } } } } },
      orderBy: { name: 'asc' },
    });
    const withPath = items.map((i) => ({ ...i, categoryPath: categoryPath(i.category) }));
    return res.json(withPath);
  } catch (err) {
    console.error('listMenuItems error:', err);
    return res.status(500).json({ error: 'Failed to fetch menu items' });
  }
}

function parseExtraOptions(raw) {
  if (!raw) return null;
  if (!Array.isArray(raw)) throw new Error('extraOptions must be an array');
  return raw.map((e) => {
    if (!e || typeof e.name !== 'string' || !e.name.trim()) throw new Error('Each extra needs a name');
    const price = Number(e.price);
    if (Number.isNaN(price) || price < 0) throw new Error(`Invalid price for extra "${e.name}"`);
    return { name: e.name.trim(), price };
  });
}

// POST /api/menu-items
async function createMenuItem(req, res) {
  const {
    name,
    price,
    imageUrl,
    categoryId,
    isAvailable,
    isFeatured,
    hasTemperatureOption,
    temperatureOptions,
    customizableIngredients,
    extraOptions,
  } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (price === undefined || price === null || Number.isNaN(Number(price)) || Number(price) < 0) {
    return res.status(400).json({ error: 'price must be a non-negative number' });
  }
  if (!categoryId) return res.status(400).json({ error: 'categoryId is required' });

  let parsedExtras;
  try {
    parsedExtras = parseExtraOptions(extraOptions);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const item = await prisma.menuItem.create({
      data: {
        name: name.trim(),
        price: Number(price),
        imageUrl: imageUrl && imageUrl.trim() ? imageUrl.trim() : null,
        categoryId,
        isAvailable: isAvailable === undefined ? true : Boolean(isAvailable),
        isFeatured: Boolean(isFeatured),
        hasTemperatureOption: Boolean(hasTemperatureOption),
        temperatureOptions: Array.isArray(temperatureOptions) ? temperatureOptions : [],
        customizableIngredients: Array.isArray(customizableIngredients) ? customizableIngredients : [],
        extraOptions: parsedExtras,
      },
      include: { category: true },
    });
    return res.status(201).json(item);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'A menu item with that name already exists' });
    if (err.code === 'P2003') return res.status(400).json({ error: 'Invalid categoryId' });
    console.error('createMenuItem error:', err);
    return res.status(500).json({ error: 'Failed to create menu item' });
  }
}

// PATCH /api/menu-items/:id — used for full edits AND for the quick
// price/availability toggles on the dashboard table.
async function updateMenuItem(req, res) {
  const { id } = req.params;
  const {
    name,
    price,
    imageUrl,
    categoryId,
    isAvailable,
    isFeatured,
    hasTemperatureOption,
    temperatureOptions,
    customizableIngredients,
    extraOptions,
  } = req.body;

  const data = {};
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    data.name = name.trim();
  }
  if (price !== undefined) {
    if (Number.isNaN(Number(price)) || Number(price) < 0) {
      return res.status(400).json({ error: 'price must be a non-negative number' });
    }
    data.price = Number(price);
  }
  if (categoryId !== undefined) data.categoryId = categoryId;
  if (imageUrl !== undefined) data.imageUrl = imageUrl && imageUrl.trim() ? imageUrl.trim() : null;
  if (isAvailable !== undefined) data.isAvailable = Boolean(isAvailable);
  if (isFeatured !== undefined) data.isFeatured = Boolean(isFeatured);
  if (hasTemperatureOption !== undefined) data.hasTemperatureOption = Boolean(hasTemperatureOption);
  if (temperatureOptions !== undefined) data.temperatureOptions = Array.isArray(temperatureOptions) ? temperatureOptions : [];
  if (customizableIngredients !== undefined) {
    data.customizableIngredients = Array.isArray(customizableIngredients) ? customizableIngredients : [];
  }
  if (extraOptions !== undefined) {
    try {
      data.extraOptions = parseExtraOptions(extraOptions);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  try {
    const item = await prisma.menuItem.update({ where: { id }, data, include: { category: true } });
    return res.json(item);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Menu item not found' });
    if (err.code === 'P2002') return res.status(409).json({ error: 'A menu item with that name already exists' });
    if (err.code === 'P2003') return res.status(400).json({ error: 'Invalid categoryId' });
    console.error('updateMenuItem error:', err);
    return res.status(500).json({ error: 'Failed to update menu item' });
  }
}

// DELETE /api/menu-items/:id — a hard delete, but menu items that already
// appear on a past order can't be removed from the database (every order
// line is a permanent record). For those, the dashboard should just mark
// the item unavailable instead — this returns a clear error saying so.
async function deleteMenuItem(req, res) {
  const { id } = req.params;
  try {
    await prisma.menuItem.delete({ where: { id } });
    return res.status(204).send();
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Menu item not found' });
    if (err.code === 'P2003') {
      return res.status(409).json({
        error: 'This item has past orders attached and can\'t be deleted — mark it unavailable instead to hide it from the menu.',
      });
    }
    console.error('deleteMenuItem error:', err);
    return res.status(500).json({ error: 'Failed to delete menu item' });
  }
}

module.exports = {
  listCategoriesFlat,
  listMenuItems,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
};
