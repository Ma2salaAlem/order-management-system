// Unified sign-in for every screen. Pick a role, sign in, and you land on
// that screen already logged in: the token is saved under the same
// localStorage keys each screen has always read (kds_<screen>_token /
// kds_<screen>_user), so the screens themselves only had to drop their own
// login forms and send people here instead.
//
// The server checks the role too (POST /api/auth/login with `screen`), so
// e.g. a waiter account can't get a token for the Cashier screen.
(function () {
  const SCREENS = {
    manager: {
      brand: 'Manager',
      subtitle: 'Manager sign in',
      path: '/admin/',
      storage: 'admin',
      demo: '<strong>manager@demo.com</strong> / <strong>password123</strong>',
    },
    cashier: {
      brand: 'Cashier',
      subtitle: 'Cashier / Manager sign in',
      path: '/cashier/',
      storage: 'cashier',
      demo: '<strong>manager@demo.com</strong> / <strong>password123</strong> — or create a cashier in the Manager Dashboard\'s Staff tab',
    },
    chef: {
      brand: 'Kitchen',
      subtitle: 'Chef / Manager sign in',
      path: '/chef/',
      storage: 'chef',
      demo: '<strong>chef@demo.com</strong> or <strong>manager@demo.com</strong> / <strong>password123</strong>',
    },
    barista: {
      brand: 'Bar',
      subtitle: 'Barista / Manager sign in',
      path: '/barista/',
      storage: 'barista',
      demo: '<strong>barista@demo.com</strong> or <strong>manager@demo.com</strong> / <strong>password123</strong>',
    },
    waiter: {
      brand: 'Waiter',
      subtitle: 'Waiter sign in',
      path: '/waiter/',
      storage: 'waiter',
      demo: '<strong>waiter@demo.com</strong> / <strong>password123</strong>',
    },
  };
  const LAST_SCREEN_KEY = 'ebony_last_screen'; // each tablet/phone remembers its usual role

  // Demo accounts (from `npm run seed`) are only advertised when running
  // on your own computer — never on the live site, where printing a
  // manager email + password on the sign-in page would let anyone in.
  const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || location.hostname.endsWith('.localhost');

  const brandRole = document.getElementById('brandRole');
  const subtitle = document.getElementById('loginSubtitle');
  const rolePicker = document.getElementById('rolePicker');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');
  const loginSubmit = document.getElementById('loginSubmit');
  const loginHint = document.getElementById('loginHint');

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  const params = new URLSearchParams(location.search);
  let current = [params.get('role'), storageGet(LAST_SCREEN_KEY), 'waiter'].find((s) => s && SCREENS[s]);

  function selectScreen(screen) {
    current = screen;
    const s = SCREENS[screen];
    brandRole.textContent = s.brand;
    subtitle.textContent = s.subtitle;
    rolePicker.querySelectorAll('.role-option').forEach((btn) => {
      const on = btn.dataset.screen === screen;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
    });
    if (IS_LOCAL) {
      loginHint.innerHTML = `Demo login — ${s.demo}<br/>(created by <span class="mono">npm run seed</span>)`;
      loginHint.classList.remove('hidden');
    }
    loginError.textContent = '';
  }

  rolePicker.addEventListener('click', (e) => {
    const btn = e.target.closest('.role-option');
    if (btn) selectScreen(btn.dataset.screen);
  });

  // Arrow keys move between roles, like any radio group
  rolePicker.addEventListener('keydown', (e) => {
    const order = Object.keys(SCREENS);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = order[(order.indexOf(current) + step + order.length) % order.length];
    selectScreen(next);
    rolePicker.querySelector(`[data-screen="${next}"]`).focus();
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const screen = current;
    const s = SCREENS[screen];

    loginSubmit.disabled = true;
    loginSubmit.textContent = 'Signing in…';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, screen }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Sign in failed (${res.status})`);

      const saved =
        storageSet(`kds_${s.storage}_token`, data.token) &&
        storageSet(`kds_${s.storage}_user`, JSON.stringify(data.user));
      if (!saved) throw new Error('This browser is blocking saved logins — turn off private mode and try again');
      storageSet(LAST_SCREEN_KEY, screen);
      location.replace(s.path);
    } catch (err) {
      loginError.textContent =
        err instanceof TypeError ? 'Can\'t reach the server — check the internet and try again' : err.message;
      loginSubmit.disabled = false;
      loginSubmit.textContent = 'Sign In';
    }
  });

  selectScreen(current);
  if (params.get('expired') === '1') {
    loginError.textContent = 'Your login expired — sign in again.';
  }
})();
