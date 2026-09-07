const prisma = require('../prisma/client');

const ORDER_INCLUDE = {
  items: { include: { menuItem: true } },
  table: true,
  waiter: true,
  cashier: true,
};

// GET /api/payments/unpaid — every COMPLETED, non-voided, unpaid order,
// regardless of date. The Cashier Dashboard groups these client-side by
// table to show which tables have an open bill right now. Deliberately
// not date-filtered: a table's earlier-in-the-day order can still be
// sitting unpaid when the cashier gets to it.
async function listUnpaidOrders(req, res) {
  try {
    const orders = await prisma.order.findMany({
      where: { status: 'COMPLETED', isVoided: false, isPaid: false },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return res.json(orders);
  } catch (err) {
    console.error('listUnpaidOrders error:', err);
    return res.status(500).json({ error: 'Failed to fetch unpaid orders' });
  }
}

// GET /api/payments/history?date=YYYY-MM-DD — paid orders for a given day
// (defaults to today), for the Cashier Dashboard's own reference/reprint list.
async function listPaymentHistory(req, res) {
  try {
    const dateParam = req.query.date;
    const dayStart = dateParam ? new Date(`${dateParam}T00:00:00.000Z`) : startOfToday();
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const orders = await prisma.order.findMany({
      where: { isPaid: true, paidAt: { gte: dayStart, lt: dayEnd } },
      include: ORDER_INCLUDE,
      orderBy: { paidAt: 'desc' },
    });
    return res.json(orders);
  } catch (err) {
    console.error('listPaymentHistory error:', err);
    return res.status(500).json({ error: 'Failed to fetch payment history' });
  }
}

const ALLOWED_METHODS = ['CASH', 'CARD', 'MOBILE_MONEY', 'TELEBIRR', 'CBE', 'BOA'];

// POST /api/payments — multipart/form-data. Fields: orderIds (JSON string
// array), paymentMethod, and an optional "screenshot" image file — the
// upload middleware (see routes/payments.js) parses the file into
// req.file and everything else lands in req.body as plain strings.
async function payOrders(req, res) {
  const { paymentMethod } = req.body;
  const cashierId = req.user.id;

  let orderIds;
  try {
    orderIds = JSON.parse(req.body.orderIds);
  } catch (e) {
    return res.status(400).json({ error: 'orderIds must be a JSON-encoded array' });
  }

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ error: 'orderIds must be a non-empty array' });
  }
  if (!ALLOWED_METHODS.includes(paymentMethod)) {
    return res.status(400).json({ error: `paymentMethod must be one of ${ALLOWED_METHODS.join(', ')}` });
  }

  try {
    const orders = await prisma.order.findMany({ where: { id: { in: orderIds } } });
    if (orders.length !== orderIds.length) {
      return res.status(400).json({ error: 'One or more orderIds are invalid' });
    }
    const notPayable = orders.find((o) => o.isVoided || o.status !== 'COMPLETED' || o.isPaid);
    if (notPayable) {
      return res.status(409).json({
        error: `Order #${notPayable.id.slice(0, 6).toUpperCase()} can't be paid — it's ${notPayable.isPaid ? 'already paid' : notPayable.isVoided ? 'voided' : `still ${notPayable.status}`}`,
      });
    }

    const paidAt = new Date();
    const screenshotUrl = req.file ? `/uploads/payment-screenshots/${req.file.filename}` : null;

    await prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: {
        isPaid: true,
        paidAt,
        paymentMethod,
        cashierId,
        ...(screenshotUrl ? { paymentScreenshotUrl: screenshotUrl } : {}),
      },
    });

    const paid = await prisma.order.findMany({
      where: { id: { in: orderIds } },
      include: ORDER_INCLUDE,
    });

    return res.status(200).json(paid);
  } catch (err) {
    console.error('payOrders error:', err);
    return res.status(500).json({ error: 'Failed to record payment' });
  }
}

function startOfToday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

module.exports = {
  listUnpaidOrders,
  listPaymentHistory,
  payOrders,
};
