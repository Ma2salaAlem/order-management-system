const bcrypt = require('bcrypt');
const prisma = require('../prisma/client');

// GET /api/users — manager only
async function listUsers(req, res) {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users);
  } catch (err) {
    console.error('listUsers error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
}

// POST /api/users — manager only, creates a new staff account
async function createUser(req, res) {
  const { name, password, role } = req.body;
  const email = (req.body.email || '').trim().toLowerCase();
  const allowedRoles = ['MANAGER', 'WAITER', 'BARISTA', 'CHEF', 'CASHIER'];

  if (!name || !email || !password || !allowedRoles.includes(role)) {
    return res.status(400).json({
      error: `name, email, password, and role are required (role must be one of ${allowedRoles.join(', ')})`,
    });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, passwordHash, role },
      select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
    });

    res.status(201).json(user);
  } catch (err) {
    console.error('createUser error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
}

// PATCH /api/users/:id — manager only, toggle active/inactive
// Deactivating an account is how you "remove" a waiter/barista without
// deleting their historical orders or audit trail.
// PATCH /api/users/:id — manager only. Handles the active/inactive toggle
// AND name/email edits (e.g. fixing a mistyped or wrongly-cased email —
// see the createUser normalization above; this is how an already-existing
// account gets corrected without needing to delete and recreate it).
async function updateUser(req, res) {
  const { id } = req.params;
  const { isActive, name, email } = req.body;

  if (isActive !== undefined && typeof isActive !== 'boolean') {
    return res.status(400).json({ error: 'isActive must be a boolean' });
  }
  if (id === req.user.id && isActive === false) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }

  const data = {};
  if (isActive !== undefined) data.isActive = isActive;
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    data.name = name.trim();
  }
  if (email !== undefined) {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return res.status(400).json({ error: 'email cannot be empty' });
    data.email = normalized;
  }

  try {
    const user = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
    });
    res.json(user);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'User not found' });
    if (err.code === 'P2002') return res.status(409).json({ error: 'A user with this email already exists' });
    console.error('updateUser error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
}

// DELETE /api/users/:id — manager only, a real hard delete. Accounts with
// any order/payment/audit history attached can't be removed from the
// database (that history is permanent) — use Deactivate for those instead.
// DELETE /api/users/:id — manager only, a real hard delete.
//
// Some links to a user are optional "who did this" attribution — a paid
// order's cashierId, a voided order's voidedById, an audit log's actorId.
// Deleting the account can safely clear those first (the payment/void/log
// record itself stays exactly as it was, just with that field blanked).
//
// Other links are NOT optional — an order's waiterId, a status change's
// changedById — those are core historical data, not attribution, so they
// still block deletion entirely. Use Deactivate for those accounts.
async function deleteUser(req, res) {
  const { id } = req.params;

  if (id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'User not found' });

    await prisma.$transaction([
      prisma.order.updateMany({ where: { cashierId: id }, data: { cashierId: null } }),
      prisma.order.updateMany({ where: { voidedById: id }, data: { voidedById: null } }),
      prisma.auditLog.updateMany({ where: { actorId: id }, data: { actorId: null } }),
      prisma.user.delete({ where: { id } }),
    ]);

    return res.status(204).send();
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'User not found' });
    if (err.code === 'P2003') {
      return res.status(409).json({
        error:
          'This account created orders or changed order statuses itself — that\'s core order history, not just attribution, so it can\'t be deleted. Use Deactivate instead.',
      });
    }
    console.error('deleteUser error:', err);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
}

module.exports = { listUsers, createUser, updateUser, deleteUser };
