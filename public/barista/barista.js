(function () {
  'use strict';

  const API = '';
  const WARNING_THRESHOLD_SEC = 5 * 60; // flag tickets sitting > 5 min
  const TEMPERATURE_LABELS = { HOT: '🔥 Hot', COLD: '🧊 Cold', NORMAL: '🌡 Normal', NORMAL_WITH_ICE: '🧊 Normal + Ice' };

  // Builds a short readable summary like "Cold • no Onions, Pickles • +Extra Cheese"
  // so the barista sees exactly how to make the drink/dish, not just its name.
  function customizationSummary(item) {
    const parts = [];
    if (item.temperature) parts.push(TEMPERATURE_LABELS[item.temperature] || item.temperature);
    if (item.removedIngredients && item.removedIngredients.length > 0) {
      parts.push(`no ${item.removedIngredients.join(', ')}`);
    }
    const extras = Array.isArray(item.selectedExtras) ? item.selectedExtras : [];
    if (extras.length > 0) {
      parts.push(`+${extras.map((e) => e.name).join(', +')}`);
    }
    return parts.join(' • ');
  }

  let token = localStorage.getItem('kds_barista_token') || null;
  let user = JSON.parse(localStorage.getItem('kds_barista_user') || 'null');
  let socket = null;
  let audioCtx = null;
  let muted = false;
  let socketConnected = false; // guard against double-connecting

  let activeTickets = []; // orders from the server, shape from GET /api/orders
  let completedTickets = [];
  let flashIds = new Set();
  let view = 'active';
  let currentDateLabel = null;

  // id -> the persistent DOM node for that ticket's card, so we can update
  // in place instead of tearing down and rebuilding every card every second.
  let ticketNodes = new Map();

  // A ticket can contain both food and drink items (e.g. a burger + a
  // coffee on the same table's order). This display only cares about the
  // drink items — walk each item's category up to its top-level ancestor
  // ("Drinks" vs "Snacks"/"Meals") and keep only the ones under Drinks.
  function topCategoryName(orderItem) {
    let c = orderItem.menuItem && orderItem.menuItem.category;
    if (!c) return null;
    while (c.parent) c = c.parent;
    return c.name;
  }
  function isDrinkItem(orderItem) {
    return topCategoryName(orderItem) === 'Drinks';
  }
  // Returns a shallow copy of the ticket with only its drink items, or
  // null if the ticket has no drink items at all (nothing to show here).
  function toDrinkTicket(ticket) {
    const drinkItems = ticket.items.filter(isDrinkItem);
    if (drinkItems.length === 0) return null;
    return { ...ticket, items: drinkItems };
  }

  // ---------------- DOM refs ----------------
  const loginScreen = document.getElementById('loginScreen');
  const appScreen = document.getElementById('appScreen');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');

  const dateDisplay = document.getElementById('dateDisplay');
  const pendingCountEl = document.getElementById('pendingCount');
  const progressCountEl = document.getElementById('progressCount');
  const muteBtn = document.getElementById('muteBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const demoOrderBtn = document.getElementById('demoOrderBtn');

  const toggleBtns = document.querySelectorAll('.toggle-btn');
  const activeView = document.getElementById('activeView');
  const completedView = document.getElementById('completedView');
  const completedGrid = document.getElementById('completedGrid');
  const completedDateInput = document.getElementById('completedDateInput');
  const activeTabCount = document.getElementById('activeTabCount');
  const completedTabCount = document.getElementById('completedTabCount');

  const orderDetailsModal = document.getElementById('orderDetailsModal');
  const orderDetailsBody = document.getElementById('orderDetailsBody');
  const orderDetailsCloseBtn = document.getElementById('orderDetailsCloseBtn');

  // ---------------- Order details modal ----------------
  // Shared by both the Active Queue and Recent Completed tabs — tapping any
  // ticket card (outside its action button) opens the full breakdown.
  function statusMeta(status) {
    if (status === 'PENDING') return { label: '⏱ Pending', color: 'var(--wait)' };
    if (status === 'IN_PROGRESS') return { label: '👨\u200d🍳 In Progress', color: 'var(--prog)' };
    if (status === 'VOIDED') return { label: '⛔ Voided', color: 'var(--danger)' };
    return { label: '✅ Completed', color: 'var(--go)' };
  }

  function openOrderDetails(ticket) {
    const meta = statusMeta(ticket.status);

    orderDetailsBody.innerHTML = `
      <div class="details-top">
        <div>
          <p class="ticket-eyebrow">Ticket</p>
          <p class="details-big mono">#${ticket.ticketNo || ticket.id.slice(0, 5).toUpperCase()}</p>
        </div>
        <div style="text-align:right">
          <p class="ticket-eyebrow">Table</p>
          <p class="details-big">${escapeHtml(ticket.table.label)}</p>
        </div>
      </div>

      <div class="details-row"><span class="details-label">Waiter</span><span>${escapeHtml(ticket.waiter.name)}</span></div>
      <div class="details-row"><span class="details-label">Placed</span><span>${new Date(ticket.createdAt).toLocaleString()}</span></div>
      <div class="details-row">
        <span class="details-label">Status</span>
        <span class="status-badge" style="background:${meta.color}">${meta.label}</span>
      </div>

      <div class="details-divider"></div>

      ${ticket.items
        .map((it) => {
          const summary = customizationSummary(it);
          return `
          <div class="details-item">
            <div class="details-item-top">
              <span>${it.quantity}× ${escapeHtml(it.menuItem.name)}</span>
            </div>
            ${summary ? `<div class="details-item-custom">${escapeHtml(summary)}</div>` : ''}
          </div>`;
        })
        .join('')}
    `;

    orderDetailsModal.classList.remove('hidden');
  }

  orderDetailsCloseBtn.addEventListener('click', () => orderDetailsModal.classList.add('hidden'));
  orderDetailsModal.addEventListener('click', (e) => {
    if (e.target === orderDetailsModal) orderDetailsModal.classList.add('hidden');
  });

  // ---------------- Date display ----------------
  function updateDateDisplay() {
    if (!dateDisplay) return;
    const label = new Date().toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    if (label !== currentDateLabel) {
      currentDateLabel = label;
      dateDisplay.textContent = label;
    }
  }

  // ---------------- API helper ----------------
  async function api(path, options = {}) {
    const res = await fetch(API + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return res.json();
  }

  // ---------------- Login ----------------
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      if (data.user.role !== 'BARISTA' && data.user.role !== 'MANAGER') {
        loginError.textContent = 'This screen is for barista or manager accounts.';
        return;
      }
      token = data.token;
      user = data.user;
      localStorage.setItem('kds_barista_token', token);
      localStorage.setItem('kds_barista_user', JSON.stringify(user));
      boot();
    } catch (err) {
      loginError.textContent = err.message || 'Login failed';
    }
  });

  function showApp() {
    loginScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
  }

  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('kds_barista_token');
    localStorage.removeItem('kds_barista_user');
    location.reload();
  });

  // ---------------- Audio chime (Web Audio, no external asset) ----------------
  function playChime() {
    if (muted) return;
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AC();
      }
      const now = audioCtx.currentTime;
      [880, 1175].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i * 0.14);
        gain.gain.exponentialRampToValueAtTime(0.22, now + i * 0.14 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.32);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now + i * 0.14);
        osc.stop(now + i * 0.14 + 0.34);
      });
    } catch (e) {
      // Audio not available in this environment — fail silently
    }
  }

  muteBtn.addEventListener('click', () => {
    muted = !muted;
    muteBtn.textContent = muted ? '🔇' : '🔊';
  });

  // ---------------- Socket ----------------
  function connectSocket() {
    if (socketConnected) return; // never attach a second set of listeners
    socketConnected = true;
    socket = io({ auth: { token } });

    // Server emits this to the barista_channel room whenever a waiter
    // sends a new order (see src/controllers/orderController.js -> createOrder)
    socket.on('new_order', (order) => {
      const drinkTicket = toDrinkTicket(order);
      if (!drinkTicket) return; // this order has no drink items — not ours to show
      const alreadyHave = activeTickets.some((t) => t.id === drinkTicket.id);
      if (alreadyHave) return; // ignore duplicate delivery
      activeTickets.unshift(drinkTicket);
      flashIds.add(drinkTicket.id);
      playChime();
      renderActive();
      updateCounts();
      setTimeout(() => {
        flashIds.delete(drinkTicket.id);
        const node = ticketNodes.get(drinkTicket.id);
        if (node) node.classList.remove('flash');
      }, 4000);
    });

    socket.on('order_voided', ({ orderId }) => {
      activeTickets = activeTickets.filter((t) => t.id !== orderId);
      renderActive();
      updateCounts();
    });

    socket.on('connect_error', (err) => {
      console.error('Socket connection error:', err.message);
    });
  }

  // ---------------- Demo order button ----------------
  // For testing without a second waiter session open. In a real service,
  // orders only ever arrive via the 'new_order' socket event above.
  const DEMO_WAITERS = ['Sara M.', 'Dawit K.', 'Liya T.'];
  const DEMO_ITEM_POOL = [
    ['Cappuccino', 'Espresso'],
    ['Iced Latte', 'Croissant'],
    ['Beef Burger', 'Loaded Fries'],
    ['Garden Salad', 'Fresh Mint Tea'],
  ];
  let demoTicketNo = 900;

  demoOrderBtn.addEventListener('click', () => {
    const rawItems = DEMO_ITEM_POOL[Math.floor(Math.random() * DEMO_ITEM_POOL.length)];
    const ticket = {
      id: `demo_${demoTicketNo}`,
      ticketNo: demoTicketNo++,
      table: { label: `T${Math.ceil(Math.random() * 8)}` },
      waiter: { name: DEMO_WAITERS[Math.floor(Math.random() * DEMO_WAITERS.length)] },
      items: rawItems.map((name) => ({ menuItem: { name }, quantity: 1 })),
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      _demo: true,
    };
    activeTickets.unshift(ticket);
    flashIds.add(ticket.id);
    playChime();
    renderActive();
    updateCounts();
    setTimeout(() => {
      flashIds.delete(ticket.id);
      const node = ticketNodes.get(ticket.id);
      if (node) node.classList.remove('flash');
    }, 4000);
  });

  // ---------------- View toggle ----------------
  toggleBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      toggleBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      view = btn.dataset.view;
      activeView.classList.toggle('hidden', view !== 'active');
      completedView.classList.toggle('hidden', view !== 'completed');
    });
  });

  // ---------------- Status actions ----------------
  async function startPreparing(ticket) {
    ticket.status = 'IN_PROGRESS';
    renderActive();
    if (ticket._demo) return; // demo tickets aren't real DB rows
    try {
      await api(`/api/orders/${ticket.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'IN_PROGRESS' }),
      });
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  }

  async function markComplete(ticket) {
    activeTickets = activeTickets.filter((t) => t.id !== ticket.id);
    completedTickets.unshift({ ...ticket, status: 'COMPLETED', completedAt: new Date().toISOString() });
    completedTickets = completedTickets.slice(0, 30);
    renderActive();
    renderCompleted();
    updateCounts();
    if (ticket._demo) return;
    try {
      await api(`/api/orders/${ticket.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'COMPLETED' }),
      });
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  }

  // ---------------- Elapsed time ----------------
  function elapsedLabel(createdAt) {
    const diffSec = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
    if (diffSec < 60) return { text: 'Just now', overdue: false };
    const m = Math.floor(diffSec / 60);
    const s = diffSec % 60;
    return { text: `${m}m ${s}s ago`, overdue: diffSec > WARNING_THRESHOLD_SEC };
  }

  // Runs every second. Touches ONLY the elapsed-time text/class on each
  // existing card — never rebuilds the card, so buttons keep their
  // listeners and the flash animation never restarts.
  function tickElapsedTimes() {
    activeTickets.forEach((ticket) => {
      const node = ticketNodes.get(ticket.id);
      if (!node) return;
      const elapsedEl = node.querySelector('.elapsed-row');
      if (!elapsedEl) return;
      const { text, overdue } = elapsedLabel(ticket.createdAt);
      elapsedEl.textContent = `${overdue ? '⚠️ ' : ''}${text}`;
      elapsedEl.classList.toggle('overdue', overdue);
    });
    updateDateDisplay();
  }

  // ---------------- Counts (pending/in-progress pills, tab counts) ----------------
  function updateCounts() {
    const pending = activeTickets.filter((t) => t.status === 'PENDING').length;
    const inProgress = activeTickets.filter((t) => t.status === 'IN_PROGRESS').length;
    pendingCountEl.textContent = pending;
    progressCountEl.textContent = inProgress;
    activeTabCount.textContent = activeTickets.length ? `(${activeTickets.length})` : '';
    completedTabCount.textContent = completedTickets.length ? `(${completedTickets.length})` : '';
  }

  // ---------------- Rendering: active queue (diff-based, no full rebuild) ----------------
  function renderActive() {
    const currentIds = new Set(activeTickets.map((t) => t.id));

    // Remove DOM nodes for tickets that are no longer active
    for (const [id, node] of ticketNodes) {
      if (!currentIds.has(id)) {
        node.remove();
        ticketNodes.delete(id);
      }
    }

    if (activeTickets.length === 0) {
      activeView.innerHTML = '<div class="empty-state">No active tickets. New orders will flash in here.</div>';
      return;
    }

    // Clear a leftover empty-state message, if any
    const emptyState = activeView.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    activeTickets.forEach((ticket, index) => {
      let node = ticketNodes.get(ticket.id);
      if (!node) {
        node = buildTicketCard(ticket);
        ticketNodes.set(ticket.id, node);
      } else {
        updateTicketCard(node, ticket);
      }
      const current = activeView.children[index];
      if (current !== node) {
        activeView.insertBefore(node, current || null);
      }
    });
  }

  // Builds a brand-new card element for a ticket that just appeared.
  function buildTicketCard(ticket) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = ticketCardHtml(ticket);
    const card = wrapper.firstElementChild;
    card.dataset.ticketId = ticket.id;
    if (flashIds.has(ticket.id)) card.classList.add('flash');
    attachTicketCardListeners(card, ticket);
    return card;
  }

  // Updates an existing card's dynamic parts in place — status badge,
  // action button, elapsed time — without touching the rest of the DOM.
  function updateTicketCard(card, ticket) {
    const isPending = ticket.status === 'PENDING';
    const accent = isPending ? 'var(--wait)' : 'var(--prog)';

    card.style.borderLeft = `6px solid ${accent}`;

    const badge = card.querySelector('.status-badge');
    if (badge) {
      badge.style.background = accent;
      badge.textContent = isPending ? '⏱ Pending' : '👨\u200d🍳 In Progress';
    }

    const elapsedEl = card.querySelector('.elapsed-row');
    if (elapsedEl) {
      const { text, overdue } = elapsedLabel(ticket.createdAt);
      elapsedEl.textContent = `${overdue ? '⚠️ ' : ''}${text}`;
      elapsedEl.classList.toggle('overdue', overdue);
    }

    const actionSlot = card.querySelector('.action-btn');
    if (actionSlot) {
      const needsStart = isPending;
      const isCurrentlyStart = actionSlot.dataset.action === 'start';
      if (needsStart !== isCurrentlyStart) {
        // status flipped — swap the button rather than rebuilding the card
        const newBtn = document.createElement('button');
        newBtn.className = `action-btn ${needsStart ? 'start' : 'complete'}`;
        newBtn.dataset.action = needsStart ? 'start' : 'complete';
        newBtn.dataset.id = ticket.id;
        newBtn.textContent = needsStart ? '👨\u200d🍳 Start Preparing' : '✅ Mark Complete';
        newBtn.addEventListener('click', () => {
          if (needsStart) startPreparing(ticket);
          else markComplete(ticket);
        });
        actionSlot.replaceWith(newBtn);
      }
    }
  }

  function attachTicketCardListeners(card, ticket) {
    const startBtn = card.querySelector('[data-action="start"]');
    if (startBtn) startBtn.addEventListener('click', () => startPreparing(ticket));
    const completeBtn = card.querySelector('[data-action="complete"]');
    if (completeBtn) completeBtn.addEventListener('click', () => markComplete(ticket));

    card.classList.add('clickable');
    card.addEventListener('click', (e) => {
      if (e.target.closest('.action-btn')) return; // let Start/Complete handle their own click
      const fresh = activeTickets.find((t) => t.id === ticket.id) || ticket;
      openOrderDetails(fresh);
    });
  }

  function ticketCardHtml(ticket) {
    const isPending = ticket.status === 'PENDING';
    const accent = isPending ? 'var(--wait)' : 'var(--prog)';
    const { text: elapsedText, overdue } = elapsedLabel(ticket.createdAt);

    return `
      <div class="ticket" style="border-left:6px solid ${accent}">
        <div class="ticket-row-top">
          <div class="ticket-id"><span class="hash">#</span>${ticket.ticketNo || ticket.id.slice(0, 5).toUpperCase()}</div>
          <div class="status-badge" style="background:${accent}">
            ${isPending ? '⏱ Pending' : '👨‍🍳 In Progress'}
          </div>
        </div>

        <div class="meta-row">
          <span>🍽 <strong>${escapeHtml(ticket.table.label)}</strong></span>
          <span class="muted">👤 ${escapeHtml(ticket.waiter.name)}</span>
        </div>

        <div class="items-box">
          <div class="items-label">Items</div>
          ${ticket.items
            .map((it) => {
              const summary = customizationSummary(it);
              return `
            <div class="item-row" style="flex-direction:column;align-items:stretch;gap:2px;">
              <div style="display:flex;justify-content:space-between;">
                <span>${escapeHtml(it.menuItem.name)}</span>
                <span class="qty mono">×${it.quantity}</span>
              </div>
              ${summary ? `<div class="item-customization">${escapeHtml(summary)}</div>` : ''}
            </div>`;
            })
            .join('')}
        </div>

        <div class="elapsed-row ${overdue ? 'overdue' : ''}">
          ${overdue ? '⚠️' : ''} ${elapsedText}
        </div>

        ${
          isPending
            ? `<button class="action-btn start" data-action="start" data-id="${ticket.id}">👨‍🍳 Start Preparing</button>`
            : `<button class="action-btn complete" data-action="complete" data-id="${ticket.id}">✅ Mark Complete</button>`
        }
      </div>`;
  }

  // Completed tab changes infrequently (only when a ticket is marked done),
  // so a full rebuild here is fine — it's never in the 1-second tick path.
  function renderCompleted() {
    if (completedTickets.length === 0) {
      completedGrid.innerHTML = '<div class="empty-state">Nothing completed on this day.</div>';
      return;
    }
    completedGrid.innerHTML = completedTickets
      .map(
        (t) => `
        <div class="completed-mini clickable" data-id="${t.id}">
          <div class="top">
            <span class="mono" style="font-weight:700;color:var(--paper)">#${t.ticketNo || t.id.slice(0, 5).toUpperCase()}</span>
            <span class="done-chip">✅ Done</span>
          </div>
          <p>${escapeHtml(t.table.label)} · ${escapeHtml(t.waiter.name)}</p>
          <p>${t.items.map((it) => `${it.quantity}× ${escapeHtml(it.menuItem.name)}`).join(', ')}</p>
        </div>`
      )
      .join('');

    completedGrid.querySelectorAll('.completed-mini').forEach((el) => {
      el.addEventListener('click', () => {
        const ticket = completedTickets.find((t) => t.id === el.dataset.id);
        if (ticket) openOrderDetails(ticket);
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Re-fetches "Recent Completed" for whichever day is selected in the
  // date picker — Active Queue is unaffected, it's always live/today.
  async function loadCompletedForSelectedDate() {
    try {
      const completed = await api(`/api/orders/completed?date=${completedDateInput.value}`);
      completedTickets = completed.map(toDrinkTicket).filter(Boolean);
      renderCompleted();
      updateCounts();
    } catch (err) {
      console.error('Failed to load completed orders for date:', err);
    }
  }

  // ---------------- Boot ----------------
  async function boot() {
    showApp();
    updateDateDisplay();
    connectSocket();
    if (!completedDateInput.value) {
      completedDateInput.value = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
    }
    completedDateInput.addEventListener('change', loadCompletedForSelectedDate);

    try {
      // Fetch the live active queue AND completed orders for the selected
      // day (defaults to today) in parallel. Without the second call,
      // "Recent Completed" only shows whatever was completed during this
      // browser session and goes empty again on every refresh — the tab
      // needs its own data from the database, for whichever day is picked.
      const [active, completed] = await Promise.all([
        api('/api/orders'),
        api(`/api/orders/completed?date=${completedDateInput.value}`),
      ]);

      const activeDrinkTickets = active.map(toDrinkTicket).filter(Boolean);
      const byId = new Map();
      [...activeDrinkTickets, ...activeTickets].forEach((t) => byId.set(t.id, t));
      activeTickets = Array.from(byId.values());

      completedTickets = completed.map(toDrinkTicket).filter(Boolean);
    } catch (err) {
      console.error('Failed to load orders:', err);
    }
    renderActive();
    renderCompleted();
    updateCounts();
    setInterval(tickElapsedTimes, 1000); // only updates elapsed-time text (and date), never rebuilds cards
  }

  if (token && user) {
    boot().catch((err) => {
      console.error('Boot failed, clearing session:', err);
      localStorage.removeItem('kds_barista_token');
      localStorage.removeItem('kds_barista_user');
      loginScreen.classList.remove('hidden');
      appScreen.classList.add('hidden');
    });
  }
})();
