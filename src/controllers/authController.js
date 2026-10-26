const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../prisma/client');

// Kitchen/bar display tablets run all day, every day — a 12h login made
// them drop to the sign-in screen mid-shift. Those roles can only view
// tickets and mark them started/done, so they get a week; roles that
// handle money or staff (cashier, manager) and waiters keep 12h.
// Deactivating an account still takes effect immediately either way —
// see the isActive check in middleware/auth.js.
const LOGIN_DURATION_BY_ROLE = { CHEF: '7d', BARISTA: '7d' };
const DEFAULT_LOGIN_DURATION = '12h';

// The unified /login page sends which screen the person is signing in to.
// Which account roles may use each screen — a manager can open any
// station's screen, everyone else only their own. Checked here, before a
// token is issued, rather than only in each screen's own JavaScript.
const SCREEN_ROLES = {
  manager: { roles: ['MANAGER'], label: 'Manager' },
  cashier: { roles: ['CASHIER', 'MANAGER'], label: 'Cashier' },
  chef: { roles: ['CHEF', 'MANAGER'], label: 'Kitchen' },
  barista: { roles: ['BARISTA', 'MANAGER'], label: 'Bar' },
  waiter: { roles: ['WAITER'], label: 'Waiter' },
};

// POST /api/auth/login — { email, password, screen? }
async function login(req, res) {
  const { email, password, screen } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  if (screen !== undefined && !SCREEN_ROLES[screen]) {
    return res.status(400).json({ error: `screen must be one of ${Object.keys(SCREEN_ROLES).join(', ')}` });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Only after the password checks out, so this can't be used to probe
    // which role an email address has.
    if (screen && !SCREEN_ROLES[screen].roles.includes(user.role)) {
      return res.status(403).json({ error: `This account can't sign in to the ${SCREEN_ROLES[screen].label} screen` });
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: LOGIN_DURATION_BY_ROLE[user.role] || DEFAULT_LOGIN_DURATION }
    );

    return res.json({
      token,
      user: { id: user.id, name: user.name, role: user.role },
    });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
}

module.exports = { login };
