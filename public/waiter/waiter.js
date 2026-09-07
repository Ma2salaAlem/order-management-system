(function () {
  'use strict';

  const API = ''; // same origin as this static file is served from

  // ---------------- State ----------------
  let token = localStorage.getItem('kds_waiter_token') || null;
  let user = JSON.parse(localStorage.getItem('kds_waiter_user') || 'null');
  let socket = null;

  let tables = [];
  let categories = [];
  let activeCategory = null; // top-level category id
  let activeSubCategory = null; // child category id, when the active category has children
  let activeSubSubCategory = null; // grandchild category id, e.g. a wine/spirit type under Alcohol
  const TOP_ITEMS_ID = '__top_items__'; // synthetic "category" for the flat, manager-curated shortcut
  let selectedTable = null;

  // basket line shape:
  // { key, menuItemId, name, unitPrice, quantity, temperature,
  //   removedIngredients: [], selectedExtras: [{name, price}] }
  let basket = [];
  let basketOpen = false;

  let myOrders = [];

  let notifications = [];
  let unread = 0;

  let currentDateLabel = null; // tracks the last date string we rendered

  // Customize-modal working state for whichever item is currently open
  let customizing = null; // the raw menu item being customized
  let customizeTemperature = null;
  let customizeRemoved = new Set();
  let customizeExtras = new Set(); // extra names
  let customizeQty = 1;

  const STATUS_META = {
    PENDING: { label: 'Pending', color: 'var(--wait)', icon: '⏱' },
    IN_PROGRESS: { label: 'In Progress', color: 'var(--prog)', icon: '👨‍🍳' },
    COMPLETED: { label: 'Completed', color: 'var(--go)', icon: '✅' },
    VOIDED: { label: 'Voided', color: 'var(--danger)', icon: '⛔' },
  };

  const TEMPERATURE_LABELS = { HOT: '🔥 Hot', COLD: '🥶 Cold', NORMAL: '🌡 Normal', NORMAL_WITH_ICE: '🧊 Normal + Ice' };
  const LEGACY_TEMPERATURE_OPTIONS = ['HOT', 'COLD', 'NORMAL']; // fallback for older items saved before per-item lists existed

  // ---------------- DOM refs ----------------
  const loginScreen = document.getElementById('loginScreen');
  const appScreen = document.getElementById('appScreen');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');

  const tableStatusLine = document.getElementById('tableStatusLine');
  const dateDisplay = document.getElementById('dateDisplay');
  const bellBtn = document.getElementById('bellBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const unreadBadge = document.getElementById('unreadBadge');
  const notifPanel = document.getElementById('notifPanel');

  const toggleBtns = document.querySelectorAll('.toggle-btn');
  const menuView = document.getElementById('menuView');
  const ordersView = document.getElementById('ordersView');
  const ordersCount = document.getElementById('ordersCount');

  const tableChips = document.getElementById('tableChips');
  const categoryTabs = document.getElementById('categoryTabs');
  const subCategoryTabs = document.getElementById('subCategoryTabs');
  const subSubCategoryTabs = document.getElementById('subSubCategoryTabs');
  const menuGrid = document.getElementById('menuGrid');
  const noTableWarning = document.getElementById('noTableWarning');
  const ordersList = document.getElementById('ordersList');
  const ordersDateInput = document.getElementById('ordersDateInput');

  const orderDetailsModal = document.getElementById('orderDetailsModal');
  const orderDetailsBody = document.getElementById('orderDetailsBody');
  const orderDetailsCloseBtn = document.getElementById('orderDetailsCloseBtn');

  const basketSheet = document.getElementById('basketSheet');
  const basketToggle = document.getElementById('basketToggle');
  const basketChevron = document.getElementById('basketChevron');
  const basketDetail = document.getElementById('basketDetail');
  const basketItemsEl = document.getElementById('basketItems');
  const basketCountEl = document.getElementById('basketCount');
  const basketTotalEl = document.getElementById('basketTotal');
  const basketTotalBigEl = document.getElementById('basketTotalBig');
  const sendOrderBtn = document.getElementById('sendOrderBtn');

  const toastEl = document.getElementById('toast');

  const customizeModal = document.getElementById('customizeModal');
  const customizeItemName = document.getElementById('customizeItemName');
  const customizeItemPrice = document.getElementById('customizeItemPrice');
  const temperatureSection = document.getElementById('temperatureSection');
  const temperatureOptions = document.getElementById('temperatureOptions');
  const ingredientsSection = document.getElementById('ingredientsSection');
  const ingredientsOptions = document.getElementById('ingredientsOptions');
  const extrasSection = document.getElementById('extrasSection');
  const extrasOptions = document.getElementById('extrasOptions');
  const customizeQtyValue = document.getElementById('customizeQtyValue');
  const customizeQtyMinus = document.getElementById('customizeQtyMinus');
  const customizeQtyPlus = document.getElementById('customizeQtyPlus');
  const customizeAddTotal = document.getElementById('customizeAddTotal');
  const customizeCancelBtn = document.getElementById('customizeCancelBtn');
  const customizeAddBtn = document.getElementById('customizeAddBtn');

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

  // ---------------- Pricing helpers ----------------
  // Mirrors src/utils/pricing.js on the server — the server is the source
  // of truth for the real charge; this is just for showing the right
  // number to the waiter before the order is even sent.
  function extrasSum(extras) {
    return (extras || []).reduce((s, e) => s + Number(e.price), 0);
  }
  function lineUnitPrice(basketLine) {
    return Number(basketLine.unitPrice) + extrasSum(basketLine.selectedExtras);
  }
  function orderItemLineTotal(orderItem) {
    const extras = Array.isArray(orderItem.selectedExtras) ? orderItem.selectedExtras : [];
    return (Number(orderItem.unitPrice) + extrasSum(extras)) * orderItem.quantity;
  }

  // Builds a short human-readable summary like "Cold • no Onions, Pickles • +Extra Cheese"
  function customizationSummary({ temperature, removedIngredients, selectedExtras }) {
    const parts = [];
    if (temperature) parts.push(TEMPERATURE_LABELS[temperature] || temperature);
    if (removedIngredients && removedIngredients.length > 0) {
      parts.push(`no ${removedIngredients.join(', ')}`);
    }
    if (selectedExtras && selectedExtras.length > 0) {
      parts.push(`+${selectedExtras.map((e) => e.name).join(', +')}`);
    }
    return parts.join(' • ');
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
      token = data.token;
      user = data.user;
      localStorage.setItem('kds_waiter_token', token);
      localStorage.setItem('kds_waiter_user', JSON.stringify(user));
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
    localStorage.removeItem('kds_waiter_token');
    localStorage.removeItem('kds_waiter_user');
    location.reload();
  });

  // ---------------- Audio chime (Web Audio, no external asset) ----------------
  let audioCtx = null;
  function playChime() {
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

  // ---------------- Socket ----------------
  function connectSocket() {
    socket = io({ auth: { token } });

    socket.on('status_updated', ({ orderId, status }) => {
      const order = myOrders.find((o) => o.id === orderId);
      if (order) order.status = status;
      renderOrders();

      const meta = STATUS_META[status] || {};
      const label = order ? `Ticket for ${order.table.label}` : 'Your order';
      pushNotification(`${label} — ${meta.label || status}`);

      // Chime only when the kitchen/bar has actually finished the order —
      // not on every status hop (e.g. Pending -> In Progress stays silent).
      if (status === 'COMPLETED') playChime();
    });

    socket.on('order_voided', ({ orderId }) => {
      const order = myOrders.find((o) => o.id === orderId);
      if (order) order.status = 'VOIDED';
      renderOrders();
      pushNotification(`An order was voided by a manager`);
    });

    socket.on('connect_error', (err) => {
      console.error('Socket connection error:', err.message);
    });
  }

  // ---------------- Notifications ----------------
  function pushNotification(text) {
    notifications.unshift({ id: Date.now(), text, time: new Date() });
    notifications = notifications.slice(0, 20);
    unread += 1;
    renderNotifBadge();
    renderNotifPanel();
    showToast(text);
  }

  function renderNotifBadge() {
    if (unread > 0) {
      unreadBadge.textContent = String(unread);
      unreadBadge.classList.remove('hidden');
    } else {
      unreadBadge.classList.add('hidden');
    }
  }

  function renderNotifPanel() {
    if (notifications.length === 0) {
      notifPanel.innerHTML = '<p class="notif-empty">No updates yet.</p>';
      return;
    }
    notifPanel.innerHTML = notifications
      .map(
        (n) => `
        <div class="notif-item">
          <p class="text">${escapeHtml(n.text)}</p>
          <p class="time">${n.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
        </div>`
      )
      .join('');
  }

  bellBtn.addEventListener('click', () => {
    notifPanel.classList.toggle('hidden');
    unread = 0;
    renderNotifBadge();
  });

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.add('hidden'), 3500);
  }

  // ---------------- View toggle ----------------
  toggleBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      toggleBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      menuView.classList.toggle('hidden', view !== 'menu');
      ordersView.classList.toggle('hidden', view !== 'orders');
      basketSheet.classList.toggle('hidden', view !== 'menu' || basket.length === 0);
      if (view === 'orders') loadMyOrders();
    });
  });

  // ---------------- Tables & menu ----------------
  async function loadTables() {
    tables = await api('/api/tables');
    tableChips.innerHTML = tables
      .map((t) => `<button class="chip" data-id="${t.id}">${escapeHtml(t.label)}</button>`)
      .join('');
    tableChips.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        selectedTable = tables.find((t) => t.id === chip.dataset.id);
        tableChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        tableStatusLine.textContent = `Serving ${selectedTable.label}`;
        noTableWarning.classList.add('hidden');
      });
    });
  }

  const TOP_CATEGORY_ICONS = { Drinks: '🥤', Meals: '🍽️', Snacks: '🍿' };

  async function loadCategories() {
    categories = await api('/api/categories');
    if (categories.length > 0) selectCategory(categories[0].id, { skipRender: true });
    const topItemsPill = `<button class="category-pill top-items-pill" data-id="${TOP_ITEMS_ID}">⭐ Top Items</button>`;
    categoryTabs.innerHTML =
      topItemsPill +
      categories
        .map((c) => {
          const icon = TOP_CATEGORY_ICONS[c.name] || '';
          return `<button class="category-pill" data-id="${c.id}">${icon ? `${icon} ` : ''}${escapeHtml(c.name)}</button>`;
        })
        .join('');
    categoryTabs.querySelectorAll('.category-pill').forEach((pill) => {
      pill.addEventListener('click', () => selectCategory(pill.dataset.id));
    });
    highlightActiveCategory();
    renderSubCategoryTabs();
    renderMenuGrid();
  }

  // Selecting a top-level category: if it has children (e.g. "Drinks" has
  // Hot Drinks/Juices & Smoothies/Soft Drinks/Alcohol), auto-select the
  // first child and show the sub-tab row. If it has no children (e.g.
  // Snacks, Meals) its own items render directly, same as before.
  function selectCategory(categoryId, { skipRender = false } = {}) {
    activeCategory = categoryId;
    const cat = categories.find((c) => c.id === categoryId);
    const children = cat && cat.children ? cat.children : [];
    activeSubCategory = children.length > 0 ? children[0].id : null;
    refreshSubSubForActiveSub();
    if (!skipRender) {
      highlightActiveCategory();
      renderSubCategoryTabs();
      renderSubSubCategoryTabs();
      renderMenuGrid();
    }
  }

  // A sub-category can itself have children (only "Alcohol" does right now
  // — Red Wine, Whisky, etc.). This keeps activeSubSubCategory in sync
  // whenever the active top category or sub-category changes.
  function refreshSubSubForActiveSub() {
    const subNode = findActiveSubNode();
    const grandchildren = subNode && subNode.children ? subNode.children : [];
    activeSubSubCategory = grandchildren.length > 0 ? grandchildren[0].id : null;
  }

  function findActiveSubNode() {
    const cat = categories.find((c) => c.id === activeCategory);
    if (!cat || !cat.children) return null;
    return cat.children.find((c) => c.id === activeSubCategory) || null;
  }

  function highlightActiveCategory() {
    categoryTabs.querySelectorAll('.category-pill').forEach((pill) => {
      pill.classList.toggle('active', pill.dataset.id === activeCategory);
    });
  }

  function renderSubCategoryTabs() {
    const cat = categories.find((c) => c.id === activeCategory);
    const children = cat && cat.children ? cat.children : [];

    if (children.length === 0) {
      subCategoryTabs.classList.add('hidden');
      subCategoryTabs.innerHTML = '';
      return;
    }

    subCategoryTabs.classList.remove('hidden');
    subCategoryTabs.innerHTML = children
      .map((c) => `<button class="subcategory-pill" data-id="${c.id}">${escapeHtml(c.name)}</button>`)
      .join('');
    subCategoryTabs.querySelectorAll('.subcategory-pill').forEach((pill) => {
      pill.classList.toggle('active', pill.dataset.id === activeSubCategory);
      pill.addEventListener('click', () => {
        activeSubCategory = pill.dataset.id;
        subCategoryTabs.querySelectorAll('.subcategory-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        refreshSubSubForActiveSub();
        renderSubSubCategoryTabs();
        renderMenuGrid();
      });
    });
  }

  // Third row — only shown when the active sub-category itself has
  // children, e.g. Alcohol -> Red Wine / Whisky / Vodka / etc.
  function renderSubSubCategoryTabs() {
    const subNode = findActiveSubNode();
    const grandchildren = subNode && subNode.children ? subNode.children : [];

    if (grandchildren.length === 0) {
      subSubCategoryTabs.classList.add('hidden');
      subSubCategoryTabs.innerHTML = '';
      return;
    }

    subSubCategoryTabs.classList.remove('hidden');
    subSubCategoryTabs.innerHTML = grandchildren
      .map((c) => `<button class="subcategory-pill subsubcategory-pill" data-id="${c.id}">${escapeHtml(c.name)}</button>`)
      .join('');
    subSubCategoryTabs.querySelectorAll('.subsubcategory-pill').forEach((pill) => {
      pill.classList.toggle('active', pill.dataset.id === activeSubSubCategory);
      pill.addEventListener('click', () => {
        activeSubSubCategory = pill.dataset.id;
        subSubCategoryTabs.querySelectorAll('.subsubcategory-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        renderMenuGrid();
      });
    });
  }

  function itemHasCustomization(item) {
    return item.hasTemperatureOption
      || (item.customizableIngredients && item.customizableIngredients.length > 0)
      || (item.extraOptions && item.extraOptions.length > 0);
  }

  // Walks the full category tree (top -> sub -> sub-sub) and returns every
  // menu item found anywhere in it — used to build the flat Top Items list
  // regardless of which category/sub-category a "regular" item lives under.
  function collectAllMenuItems(nodes) {
    let all = [];
    (nodes || []).forEach((node) => {
      if (Array.isArray(node.menuItems)) all = all.concat(node.menuItems);
      if (Array.isArray(node.children) && node.children.length > 0) all = all.concat(collectAllMenuItems(node.children));
    });
    return all;
  }

  function renderMenuGrid() {
    let items = [];

    if (activeCategory === TOP_ITEMS_ID) {
      items = collectAllMenuItems(categories).filter((i) => i.isFeatured);
    } else {
      const cat = categories.find((c) => c.id === activeCategory);
      if (cat && cat.children && cat.children.length > 0) {
        const subCat = cat.children.find((c) => c.id === activeSubCategory) || cat.children[0];
        if (subCat && subCat.children && subCat.children.length > 0) {
          const subSubCat = subCat.children.find((c) => c.id === activeSubSubCategory) || subCat.children[0];
          items = subSubCat ? subSubCat.menuItems : [];
        } else {
          items = subCat ? subCat.menuItems : [];
        }
      } else if (cat) {
        items = cat.menuItems;
      }
    }

    if (activeCategory === TOP_ITEMS_ID && items.length === 0) {
      menuGrid.innerHTML = `<p class="no-table-warning" style="position:static;">No Top Items marked yet — your manager can star items from the Manager Dashboard's Menu tab.</p>`;
      return;
    }

    menuGrid.innerHTML = items
      .map(
        (item) => `
        <div class="menu-card">
          <div>
            ${item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="" class="menu-card-img" />` : ''}
            <div class="name">${escapeHtml(item.name)}</div>
            <div class="price mono">$${Number(item.price).toFixed(2)}</div>
          </div>
          <button class="add-btn" data-id="${item.id}">+</button>
        </div>`
      )
      .join('');

    menuGrid.querySelectorAll('.add-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = items.find((i) => i.id === btn.dataset.id);
        if (itemHasCustomization(item)) {
          openCustomizeModal(item);
        } else {
          addToBasket({
            key: item.id, // no customization possible, so the menu item id alone is a stable merge key
            menuItemId: item.id,
            name: item.name,
            unitPrice: Number(item.price),
            quantity: 1,
            temperature: null,
            removedIngredients: [],
            selectedExtras: [],
          });
        }
      });
    });
  }

  // ---------------- Customize modal ----------------
  function openCustomizeModal(item) {
    customizing = item;
    customizeTemperature = null;
    customizeRemoved = new Set();
    customizeExtras = new Set();
    customizeQty = 1;

    customizeItemName.textContent = item.name;
    customizeItemPrice.textContent = `$${Number(item.price).toFixed(2)} base`;

    // Temperature
    if (item.hasTemperatureOption) {
      temperatureSection.classList.remove('hidden');
      // Use this item's own allowed choices (e.g. bar drinks offer
      // Cold/Normal/Normal+Ice, coffee offers Hot/Cold/Normal) — fall back
      // to the legacy three-option set for any item saved before this field existed.
      const allowedTemps = (item.temperatureOptions && item.temperatureOptions.length > 0)
        ? item.temperatureOptions
        : LEGACY_TEMPERATURE_OPTIONS;
      temperatureOptions.innerHTML = allowedTemps
        .map((key) => `<button type="button" class="option-chip" data-temp="${key}">${TEMPERATURE_LABELS[key] || key}</button>`)
        .join('');
      temperatureOptions.querySelectorAll('.option-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          customizeTemperature = chip.dataset.temp;
          temperatureOptions.querySelectorAll('.option-chip').forEach((c) => c.classList.remove('selected'));
          chip.classList.add('selected');
          updateCustomizeTotal();
        });
      });
    } else {
      temperatureSection.classList.add('hidden');
    }

    // Removable ingredients
    if (item.customizableIngredients && item.customizableIngredients.length > 0) {
      ingredientsSection.classList.remove('hidden');
      ingredientsOptions.innerHTML = item.customizableIngredients
        .map((ing) => `<button type="button" class="option-chip" data-ing="${escapeHtml(ing)}">${escapeHtml(ing)}</button>`)
        .join('');
      ingredientsOptions.querySelectorAll('.option-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const ing = chip.dataset.ing;
          if (customizeRemoved.has(ing)) {
            customizeRemoved.delete(ing);
            chip.classList.remove('selected');
          } else {
            customizeRemoved.add(ing);
            chip.classList.add('selected');
          }
        });
      });
    } else {
      ingredientsSection.classList.add('hidden');
    }

    // Extras
    const extras = Array.isArray(item.extraOptions) ? item.extraOptions : [];
    if (extras.length > 0) {
      extrasSection.classList.remove('hidden');
      extrasOptions.innerHTML = extras
        .map(
          (ex) => `
          <button type="button" class="option-chip" data-extra="${escapeHtml(ex.name)}" data-price="${ex.price}">
            ${escapeHtml(ex.name)} <span class="extra-price">+$${Number(ex.price).toFixed(2)}</span>
          </button>`
        )
        .join('');
      extrasOptions.querySelectorAll('.option-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const name = chip.dataset.extra;
          if (customizeExtras.has(name)) {
            customizeExtras.delete(name);
            chip.classList.remove('selected');
          } else {
            customizeExtras.add(name);
            chip.classList.add('selected');
          }
          updateCustomizeTotal();
        });
      });
    } else {
      extrasSection.classList.add('hidden');
    }

    customizeQtyValue.textContent = customizeQty;
    updateCustomizeTotal();
    customizeModal.classList.remove('hidden');
  }

  function currentCustomizeExtrasPriced() {
    const extras = Array.isArray(customizing.extraOptions) ? customizing.extraOptions : [];
    return extras.filter((e) => customizeExtras.has(e.name));
  }

  function updateCustomizeTotal() {
    const unit = Number(customizing.price) + extrasSum(currentCustomizeExtrasPriced());
    customizeAddTotal.textContent = `$${(unit * customizeQty).toFixed(2)}`;
  }

  customizeQtyMinus.addEventListener('click', () => {
    if (customizeQty > 1) {
      customizeQty -= 1;
      customizeQtyValue.textContent = customizeQty;
      updateCustomizeTotal();
    }
  });
  customizeQtyPlus.addEventListener('click', () => {
    customizeQty += 1;
    customizeQtyValue.textContent = customizeQty;
    updateCustomizeTotal();
  });

  customizeCancelBtn.addEventListener('click', () => {
    customizeModal.classList.add('hidden');
  });

  customizeAddBtn.addEventListener('click', () => {
    if (customizing.hasTemperatureOption && !customizeTemperature) {
      showToast('Pick a temperature first');
      return;
    }
    const removedIngredients = Array.from(customizeRemoved);
    const selectedExtras = currentCustomizeExtrasPriced();
    const key = [
      customizing.id,
      customizeTemperature || '',
      removedIngredients.slice().sort().join(','),
      selectedExtras.map((e) => e.name).sort().join(','),
    ].join('|');

    addToBasket({
      key,
      menuItemId: customizing.id,
      name: customizing.name,
      unitPrice: Number(customizing.price),
      quantity: customizeQty,
      temperature: customizeTemperature,
      removedIngredients,
      selectedExtras,
    });

    customizeModal.classList.add('hidden');
  });

  // ---------------- Basket ----------------
  function addToBasket(line) {
    const existing = basket.find((b) => b.key === line.key);
    if (existing) {
      existing.quantity += line.quantity;
    } else {
      basket.push(line);
    }
    basketOpen = true;
    renderBasket();
  }

  function changeQty(key, delta) {
    const item = basket.find((b) => b.key === key);
    if (!item) return;
    item.quantity += delta;
    if (item.quantity <= 0) basket = basket.filter((b) => b.key !== key);
    renderBasket();
  }

  function renderBasket() {
    const count = basket.reduce((s, b) => s + b.quantity, 0);
    const total = basket.reduce((s, b) => s + b.quantity * lineUnitPrice(b), 0);

    basketSheet.classList.toggle('hidden', count === 0);
    basketCountEl.textContent = count;
    basketTotalEl.textContent = `$${total.toFixed(2)}`;
    basketTotalBigEl.textContent = `$${total.toFixed(2)}`;
    basketDetail.classList.toggle('hidden', !basketOpen);
    basketChevron.textContent = basketOpen ? '▼' : '▲';

    basketItemsEl.innerHTML = basket
      .map((b) => {
        const summary = customizationSummary(b);
        return `
        <div class="basket-item-row">
          <div>
            <div class="basket-item-name">${escapeHtml(b.name)}</div>
            ${summary ? `<div class="item-customization">${escapeHtml(summary)}</div>` : ''}
            <div class="basket-item-price mono">$${lineUnitPrice(b).toFixed(2)} each</div>
          </div>
          <div class="qty-controls">
            <button class="qty-btn minus" data-key="${b.key}" data-delta="-1">${b.quantity === 1 ? '🗑' : '−'}</button>
            <span class="qty-value">${b.quantity}</span>
            <button class="qty-btn plus" data-key="${b.key}" data-delta="1">+</button>
          </div>
        </div>`;
      })
      .join('');

    basketItemsEl.querySelectorAll('.qty-btn').forEach((btn) => {
      btn.addEventListener('click', () => changeQty(btn.dataset.key, Number(btn.dataset.delta)));
    });

    sendOrderBtn.disabled = !selectedTable || basket.length === 0;

    if (!selectedTable && basket.length > 0) {
      noTableWarning.classList.remove('hidden');
    }
  }

  basketToggle.addEventListener('click', () => {
    basketOpen = !basketOpen;
    renderBasket();
  });

  sendOrderBtn.addEventListener('click', async () => {
    if (!selectedTable || basket.length === 0) return;
    sendOrderBtn.disabled = true;
    sendOrderBtn.textContent = 'Sending…';
    try {
      await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          tableId: selectedTable.id,
          items: basket.map((b) => ({
            menuItemId: b.menuItemId,
            quantity: b.quantity,
            temperature: b.temperature || undefined,
            removedIngredients: b.removedIngredients,
            extraNames: b.selectedExtras.map((e) => e.name),
          })),
        }),
      });
      basket = [];
      basketOpen = false;
      renderBasket();
      // switch to the Orders tab so the waiter sees the new ticket
      document.querySelector('.toggle-btn[data-view="orders"]').click();
    } catch (err) {
      showToast(err.message || 'Failed to send order');
    } finally {
      sendOrderBtn.disabled = false;
      sendOrderBtn.textContent = '📨 Send to Barista';
    }
  });

  // ---------------- Orders (tickets) ----------------
  async function loadMyOrders() {
    try {
      const date = ordersDateInput.value; // YYYY-MM-DD, defaults to today via boot()
      myOrders = await api(`/api/orders/mine?date=${date}`);
      renderOrders();
    } catch (err) {
      console.error(err);
    }
  }

  ordersDateInput.addEventListener('change', loadMyOrders);

  // Tapping any ticket in "My Orders" opens the full breakdown — same
  // total/items already on the card, plus placed time and void reason
  // when a manager has voided it.
  function openOrderDetails(order) {
    const meta = STATUS_META[order.status] || STATUS_META.PENDING;
    const total = order.items.reduce((s, i) => s + orderItemLineTotal(i), 0);

    orderDetailsBody.innerHTML = `
      <div class="details-top">
        <div>
          <p class="ticket-eyebrow">Ticket</p>
          <p class="details-big mono">#${order.id.slice(0, 6).toUpperCase()}</p>
        </div>
        <div style="text-align:right">
          <p class="ticket-eyebrow">Table</p>
          <p class="details-big">${escapeHtml(order.table.label)}</p>
        </div>
      </div>

      <div class="details-row"><span class="details-label">Placed</span><span>${new Date(order.createdAt).toLocaleString()}</span></div>
      <div class="details-row">
        <span class="details-label">Status</span>
        <span class="status-chip" style="background:${meta.color};display:inline-flex;padding:4px 10px;">${meta.icon} ${meta.label}</span>
      </div>

      <div class="details-divider"></div>

      ${order.items
        .map((it) => {
          const summary = customizationSummary({
            temperature: it.temperature,
            removedIngredients: it.removedIngredients,
            selectedExtras: it.selectedExtras,
          });
          return `
          <div class="details-item">
            <div class="details-item-top">
              <span>${it.quantity}× ${escapeHtml(it.menuItem.name)}</span>
              <span class="mono">$${orderItemLineTotal(it).toFixed(2)}</span>
            </div>
            ${summary ? `<div class="details-item-custom">${escapeHtml(summary)}</div>` : ''}
          </div>`;
        })
        .join('')}

      <div class="details-divider"></div>

      <div class="details-row details-total">
        <span>Total</span>
        <span class="mono">$${total.toFixed(2)}</span>
      </div>

      ${
        order.status === 'VOIDED'
          ? `
        <div class="void-info-box">
          <p class="void-info-title">⛔ Voided</p>
          <div class="details-row"><span class="details-label">Reason</span><span>${escapeHtml(order.voidReason || 'No reason given')}</span></div>
          ${order.voidedAt ? `<div class="details-row"><span class="details-label">Voided at</span><span>${new Date(order.voidedAt).toLocaleString()}</span></div>` : ''}
        </div>`
          : ''
      }
    `;

    orderDetailsModal.classList.remove('hidden');
  }

  orderDetailsCloseBtn.addEventListener('click', () => orderDetailsModal.classList.add('hidden'));
  orderDetailsModal.addEventListener('click', (e) => {
    if (e.target === orderDetailsModal) orderDetailsModal.classList.add('hidden');
  });

  function renderOrders() {
    ordersCount.textContent = myOrders.length ? `(${myOrders.length})` : '';

    if (myOrders.length === 0) {
      ordersList.innerHTML = '<p class="orders-empty">No orders sent yet this session.</p>';
      return;
    }

    ordersList.innerHTML = myOrders
      .map((order) => {
        const meta = STATUS_META[order.status] || STATUS_META.PENDING;
        const total = order.items.reduce((s, i) => s + orderItemLineTotal(i), 0);
        return `
        <div class="ticket-card clickable" data-id="${order.id}">
          <div class="ticket-perforation"></div>
          <div class="ticket-top">
            <div>
              <p class="ticket-eyebrow">Ticket</p>
              <p class="ticket-num mono">#${order.id.slice(0, 6).toUpperCase()}</p>
            </div>
            <div style="text-align:right">
              <p class="ticket-eyebrow">Table</p>
              <p class="ticket-num">${escapeHtml(order.table.label)}</p>
            </div>
          </div>
          <hr class="ticket-divider" />
          ${order.items
            .map((it) => {
              const summary = customizationSummary({
                temperature: it.temperature,
                removedIngredients: it.removedIngredients,
                selectedExtras: it.selectedExtras,
              });
              return `
            <div class="ticket-item-row" style="flex-direction:column;align-items:stretch;">
              <div style="display:flex;justify-content:space-between;">
                <span>${it.quantity}× ${escapeHtml(it.menuItem.name)}</span>
                <span class="mono">$${orderItemLineTotal(it).toFixed(2)}</span>
              </div>
              ${summary ? `<div class="item-customization">${escapeHtml(summary)}</div>` : ''}
            </div>`;
            })
            .join('')}
          <hr class="ticket-divider" />
          <div class="ticket-total-row">
            <span>Total</span>
            <span class="mono">$${total.toFixed(2)}</span>
          </div>
          <div class="ticket-actions">
            <div class="status-chip" style="background:${meta.color}">
              ${meta.icon} ${meta.label}
            </div>
            <div class="cancel-locked" title="Cancelling requires manager approval">
              🔒 Cancel
            </div>
          </div>
        </div>`;
      })
      .join('');

    ordersList.querySelectorAll('.ticket-card').forEach((el) => {
      el.addEventListener('click', () => {
        const order = myOrders.find((o) => o.id === el.dataset.id);
        if (order) openOrderDetails(order);
      });
    });
  }

  // ---------------- Boot ----------------
  async function boot() {
    showApp();
    updateDateDisplay();
    setInterval(updateDateDisplay, 60 * 1000); // catches the date rolling over past midnight
    if (!ordersDateInput.value) {
      ordersDateInput.value = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
    }
    connectSocket();
    await Promise.all([loadTables(), loadCategories()]);
    await loadMyOrders();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Auto-login if a token is already stored
  if (token && user) {
    boot().catch((err) => {
      console.error('Boot failed, clearing session:', err);
      localStorage.removeItem('kds_waiter_token');
      localStorage.removeItem('kds_waiter_user');
      loginScreen.classList.remove('hidden');
      appScreen.classList.add('hidden');
    });
  }
})();
