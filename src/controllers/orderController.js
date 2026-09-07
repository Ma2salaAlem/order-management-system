const prisma = require('../prisma/client');
const { getIO } = require('../socket');
const { logOrderCreated } = require('../middleware/auditLogger');
const { lineTotal } = require('../utils/pricing');

// Fallback for older/legacy menu items that predate the per-item
// temperatureOptions field (their array is empty in the database).
// New items — including all the bar drinks — set their own explicit list.
const LEGACY_TEMPERATURE_OPTIONS = ['HOT', 'COLD', 'NORMAL'];

// Turns one raw request item into validated OrderItem.create data, pricing
// extras from the menu item's own extraOptions — never from whatever price
// the client happened to send. Throws a plain Error with a user-facing
// message on any invalid selection; createOrder below turns that into a 400.
function buildOrderItemData(menuItem, reqItem) {
  const quantity = reqItem.quantity || 1;
  let temperature = null;
  if (reqItem.temperature) {
    if (!menuItem.hasTemperatureOption) {
      throw new Error(`${menuItem.name} doesn't have a temperature option`);
    }
    const allowed = Array.isArray(menuItem.temperatureOptions) && menuItem.temperatureOptions.length > 0
      ? menuItem.temperatureOptions
      : LEGACY_TEMPERATURE_OPTIONS;
    if (!allowed.includes(reqItem.temperature)) {
      throw new Error(`Invalid temperature "${reqItem.temperature}" for ${menuItem.name}`);
    }
    temperature = reqItem.temperature;
  }

  const removedIngredients = Array.isArray(reqItem.removedIngredients) ? reqItem.removedIngredients : [];
  for (const ing of removedIngredients) {
    if (!menuItem.customizableIngredients.includes(ing)) {
      throw new Error(`"${ing}" isn't a customizable ingredient on ${menuItem.name}`);
    }
  }

  const requestedExtraNames = Array.isArray(reqItem.extraNames) ? reqItem.extraNames : [];
  const availableExtras = Array.isArray(menuItem.extraOptions) ? menuItem.extraOptions : [];
  const selectedExtras = requestedExtraNames.map((name) => {
    const match = availableExtras.find((e) => e.name === name);
    if (!match) throw new Error(`"${name}" isn't a valid extra on ${menuItem.name}`);
    return { name: match.name, price: Number(match.price) }; // server-priced snapshot
  });

  return {
    menuItemId: menuItem.id,
    quantity,
    notes: reqItem.notes || null,
    unitPrice: menuItem.price,
    temperature,
    removedIngredients,
    selectedExtras: selectedExtras.length > 0 ? selectedExtras : null,
  };
}

// POST /api/orders — Waiter submits an order
async function createOrder(req, res) {
  const { tableId, items } = req.body; // items: [{ menuItemId, quantity, notes, temperature, removedIngredients, extraNames }]
  const waiterId = req.user.id;

  if (!tableId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'tableId and at least one item are required' });
  }

  try {
    const menuItemIds = items.map((i) => i.menuItemId);
    const menuItems = await prisma.menuItem.findMany({
      where: { id: { in: menuItemIds } },
    });

    if (menuItems.length !== menuItemIds.length) {
      return res.status(400).json({ error: 'One or more menuItemId values are invalid' });
    }

    const menuItemById = Object.fromEntries(menuItems.map((m) => [m.id, m]));

    let orderItemsData;
    try {
      orderItemsData = items.map((reqItem) => buildOrderItemData(menuItemById[reqItem.menuItemId], reqItem));
    } catch (validationErr) {
      return res.status(400).json({ error: validationErr.message });
    }

    let stockWasDecremented = false;

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          tableId,
          waiterId,
          status: 'PENDING',
          items: { create: orderItemsData },
          statusLogs: {
            create: { fromStatus: null, toStatus: 'PENDING', changedById: waiterId },
          },
        },
        include: { items: { include: { menuItem: { include: { category: { include: { parent: { include: { parent: true } } } } } } } }, table: true, waiter: true },
      });

      // Draw down any stock linked to the menu items just sold (see
      // MenuItemStock — a stock item can be shared across several menu
      // items, e.g. a bag of coffee beans used by multiple drinks). Runs
      // in the same transaction as the order itself so a stock update can
      // never happen without the order it came from, or vice versa.
      for (const reqItem of items) {
        const links = await tx.menuItemStock.findMany({ where: { menuItemId: reqItem.menuItemId } });
        for (const link of links) {
          const soldQty = reqItem.quantity || 1;
          await tx.stockItem.update({
            where: { id: link.stockItemId },
            data: { quantity: { decrement: Number(link.qtyPerSale) * soldQty } },
          });
          stockWasDecremented = true;
        }
      }

      return created;
    });

    await logOrderCreated(order, req);

    // Let the Manager Dashboard's Stock tab refresh itself in real time —
    // it just needs to know *something* changed, not what, since it
    // already has a cheap GET /api/stock to re-fetch the full picture.
    if (stockWasDecremented) {
      getIO().to('manager_channel').emit('stock_changed');
    }

    // Push to the barista/manager display in real time
    getIO().to('barista_channel').emit('new_order', order);

    return res.status(201).json(order);
  } catch (err) {
    console.error('createOrder error:', err);
    return res.status(500).json({ error: 'Failed to create order' });
  }
}

// PATCH /api/orders/:id/status — Barista/manager updates status
async function updateOrderStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body; // 'IN_PROGRESS' | 'COMPLETED'
  const changedById = req.user.id;

  const allowedTransitions = ['IN_PROGRESS', 'COMPLETED'];
  if (!allowedTransitions.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${allowedTransitions.join(', ')}` });
  }

  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Order not found' });
    if (existing.isVoided) return res.status(409).json({ error: 'Cannot update a voided order' });

    const updated = await prisma.order.update({
      where: { id },
      data: {
        status,
        statusLogs: { create: { fromStatus: existing.status, toStatus: status, changedById } },
      },
      include: { waiter: true, items: { include: { menuItem: { include: { category: { include: { parent: { include: { parent: true } } } } } } } } },
    });

    // Notify only the waiter who owns this order
    getIO().to(`waiter_${updated.waiterId}`).emit('status_updated', {
      orderId: updated.id,
      status: updated.status,
    });
    // Managers watch everything for oversight
    getIO().to('manager_channel').emit('status_updated', {
      orderId: updated.id,
      status: updated.status,
    });

    return res.json(updated);
  } catch (err) {
    console.error('updateOrderStatus error:', err);
    return res.status(500).json({ error: 'Failed to update status' });
  }
}

// DELETE /api/orders/:id — Manager-only void (roleGuard blocks non-managers
// before this ever runs). This is a soft delete — nothing is erased.
async function voidOrder(req, res) {
  const { id } = req.params;
  const { reason } = req.body;
  const managerId = req.user.id;

  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Order not found' });
    if (existing.isPaid) return res.status(409).json({ error: 'Cannot void an order that has already been paid' });

    const voided = await prisma.order.update({
      where: { id },
      data: {
        isVoided: true,
        voidedById: managerId,
        voidReason: reason || 'No reason provided',
        voidedAt: new Date(),
        status: 'VOIDED',
        statusLogs: { create: { fromStatus: existing.status, toStatus: 'VOIDED', changedById: managerId } },
      },
    });

    getIO().to('barista_channel').emit('order_voided', { orderId: id });
    getIO().to(`waiter_${existing.waiterId}`).emit('order_voided', { orderId: id });

    return res.json(voided);
  } catch (err) {
    console.error('voidOrder error:', err);
    return res.status(500).json({ error: 'Failed to void order' });
  }
}

// GET /api/orders — active queue for the Barista Display (barista/manager only)
async function listActiveOrders(req, res) {
  try {
    const orders = await prisma.order.findMany({
      where: { isVoided: false, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      include: { items: { include: { menuItem: { include: { category: { include: { parent: { include: { parent: true } } } } } } } }, table: true, waiter: true },
      orderBy: { createdAt: 'asc' },
    });
    return res.json(orders);
  } catch (err) {
    console.error('listActiveOrders error:', err);
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
}

// GET /api/orders/mine?date=YYYY-MM-DD — a waiter's own orders for a given
// day (defaults to today). This is what lets a waiter flip back through
// past days/weeks/months of their own order history, not just live ones.
async function listMyOrders(req, res) {
  try {
    const dateParam = req.query.date;
    const dayStart = dateParam ? new Date(`${dateParam}T00:00:00.000Z`) : startOfToday();
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const orders = await prisma.order.findMany({
      where: { waiterId: req.user.id, createdAt: { gte: dayStart, lt: dayEnd } },
      include: { items: { include: { menuItem: { include: { category: { include: { parent: { include: { parent: true } } } } } } } }, table: true },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(orders);
  } catch (err) {
    console.error('listMyOrders error:', err);
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
}

// GET /api/orders/all?date=YYYY-MM-DD — every order for a given day
// (pending, in progress, completed, and voided) — manager dashboard only.
async function listAllOrdersForDay(req, res) {
  try {
    const dateParam = req.query.date;
    const dayStart = dateParam ? new Date(`${dateParam}T00:00:00.000Z`) : startOfToday();
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const orders = await prisma.order.findMany({
      where: { createdAt: { gte: dayStart, lt: dayEnd } },
      include: { items: { include: { menuItem: { include: { category: { include: { parent: { include: { parent: true } } } } } } } }, table: true, waiter: true, voidedBy: true },
      orderBy: { createdAt: 'desc' },
    });

    return res.json(orders);
  } catch (err) {
    console.error('listAllOrdersForDay error:', err);
    return res.status(500).json({ error: 'Failed to fetch orders' });
  }
}

// GET /api/orders/completed?date=YYYY-MM-DD — completed orders for a given
// day (defaults to today), for the Barista Display's "Recent Completed" tab.
// A date picker on that tab lets a barista browse past days the same way.
async function listCompletedToday(req, res) {
  try {
    const dateParam = req.query.date;
    const dayStart = dateParam ? new Date(`${dateParam}T00:00:00.000Z`) : startOfToday();
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const orders = await prisma.order.findMany({
      where: {
        status: 'COMPLETED',
        isVoided: false,
        createdAt: { gte: dayStart, lt: dayEnd },
      },
      include: { items: { include: { menuItem: { include: { category: { include: { parent: { include: { parent: true } } } } } } } }, table: true, waiter: true },
      orderBy: { updatedAt: 'desc' },
    });

    return res.json(orders);
  } catch (err) {
    console.error('listCompletedToday error:', err);
    return res.status(500).json({ error: 'Failed to fetch completed orders' });
  }
}

function startOfToday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

module.exports = {
  createOrder,
  updateOrderStatus,
  voidOrder,
  listActiveOrders,
  listMyOrders,
  listAllOrdersForDay,
  listCompletedToday,
};
