# Order Management System

Waiter → Barista order flow with real-time Socket.io updates, manager-gated
voids, an audit-logged daily reconciliation report, and a Manager Dashboard
for staff control and oversight.

```
order-management-system/
├── prisma/schema.prisma       # Postgres schema (Users, Tables, Menu, Orders, AuditLog)
├── src/                       # Express + Socket.io backend
├── public/waiter/             # Waiter mobile ordering screen (HTML/CSS/JS)
├── public/barista/            # Barista Display System (HTML/CSS/JS)
├── public/admin/               # Manager Dashboard — revenue, orders, staff (HTML/CSS/JS)
└── docker-compose.yml         # Local Postgres, so you don't need to install it yourself
```

## Requirements

- Node.js 18+ and npm
- Docker (recommended, for Postgres) — or your own local Postgres instance

## 1. Install dependencies

```bash
npm install
```

## 2. Start a database

**Option A — Docker (easiest):**
```bash
docker compose up -d
```
This starts Postgres on `localhost:5432` with user/password `postgres`/`postgres`
and a database named `kds_db`, matching the default `.env` values below.

**Option B — your own Postgres:** create a database and note its connection string.

## 3. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and set `JWT_SECRET` to a random string. You can generate one with:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
If you used `docker compose up -d` above, `DATABASE_URL` in `.env.example`
already points at the right place — no changes needed there.

## 4. Create the database tables

```bash
npx prisma migrate dev --name init
npx prisma generate
```

## 5. Seed demo data (users, tables, menu items)

```bash
npm run seed
```

This creates three demo logins (all with password `password123`):

| Role    | Email               |
|---------|----------------------|
| Manager | manager@demo.com     |
| Waiter  | waiter@demo.com      |
| Barista | barista@demo.com     |

It also creates 10 tables (T1–T10) and a starter menu across Drinks, Snacks,
and Meals categories.

## 6. Run the app

```bash
npm start
```

You should see:
```
Order Management System running:
  → API:     http://localhost:4000/api
  → Waiter:  http://localhost:4000/waiter/
  → Barista: http://localhost:4000/barista/
```

Also available once the server is running: **`http://localhost:4000/admin/`**
— the Manager Dashboard (sign in as `manager@demo.com`).

## 7. Try it out

1. Open **http://localhost:4000/waiter/** in one browser tab (or your phone,
   if it's on the same network — use your machine's LAN IP instead of
   `localhost`). Sign in as `waiter@demo.com`.
2. Open **http://localhost:4000/barista/** in another tab. Sign in as
   `barista@demo.com`.
3. On the waiter screen: pick a table, add a few items, and tap **Send to
   Barista**. It should appear instantly on the barista screen with a chime
   and a flash — no page refresh needed.
4. On the barista screen: tap **Start Preparing**, then **Mark Complete**.
   Switch back to the waiter tab's **Active Orders** view — the status
   updates live via the same socket connection.
5. Notice the waiter's ticket has a **locked Cancel button** — that's
   intentional. Voiding an order requires a manager, via
   `DELETE /api/orders/:id`, which is blocked server-side by role for any
   other account (see `src/middleware/roleGuard.js`).
6. Open **http://localhost:4000/admin/** in a third tab and sign in as
   `manager@demo.com`. You should see today's orders and revenue reflected
   there — including the order you just sent — since it's reading from the
   same live database.

For development with auto-restart on file changes, use `npm run dev`
instead of `npm start` (requires `nodemon`, already in devDependencies).

## Hosting it online (no command line)

`render.yaml` lets [Render](https://render.com) set everything up from its
website: sign in with GitHub → **New** → **Blueprint** → pick this repo →
**Apply**. It creates the app and a Postgres database, generates
`JWT_SECRET`, runs migrations, and seeds the demo data on first boot
(`src/seedIfEmpty.js` skips seeding once users exist, so redeploys don't
reset your menu). You get a public `https://….onrender.com` URL — add
`/waiter/`, `/barista/`, `/chef/` or `/admin/` to it.

Free-tier caveats: the app sleeps after ~15 minutes idle (first visit then
takes ~1 minute), the free database expires after 30 days unless upgraded,
and uploaded payment screenshots are lost on each redeploy. Anyone with the
URL can sign in with the demo logins (all `password123`). Before sharing,
add your own accounts under **Staff** in the Manager Dashboard, sign in as
your new manager, and deactivate the four `@demo.com` accounts.

## Item customization (temperature, ingredients, extras)

Menu items can now carry three kinds of customization, all defined per
item in `prisma/schema.prisma` / seeded in `src/seed.js`:

- **Temperature** (`hasTemperatureOption`) — Hot / Cold / Normal, for drinks
- **Removable ingredients** (`customizableIngredients`) — a list like
  `["Onions", "Pickles", "Cheese"]` the waiter can toggle off per order
- **Priced extras** (`extraOptions`) — e.g. `{"name":"Extra Shot","price":0.75}`

When a waiter taps `+` on an item that has any of these, a customization
sheet opens instead of adding it straight to the basket. The choice gets
priced and validated **server-side** in `orderController.js`'s
`buildOrderItemData()` — a client can't invent an extra's price or claim
an ingredient exists that isn't on the menu item; the request is rejected
with a 400 if it tries. The Barista Display, Waiter's own tickets, and the
Manager Dashboard's order details all show the same customization summary
(e.g. "🧊 Cold • no Onions, Pickles • +Extra Cheese") pulled from that
validated, stored data — not from whatever the waiter typed.

**If you already had this project set up before this feature was added**,
the schema changed (new `DrinkTemperature` enum, new columns on
`MenuItem` and `OrderItem`), so you'll need to run a fresh migration:
```bash
npx prisma migrate dev --name add_item_customization
npm run seed
```
Re-running `npm run seed` is safe — it's an upsert, so it fills in the new
customization options on your existing menu items without duplicating them
or touching your users, tables, or past orders.

## Manager Dashboard

`http://localhost:4000/admin/` gives a manager three things:

- **Overview** — a daily reconciliation report for any date: orders placed,
  orders voided, live revenue vs. audit-logged revenue (these should always
  match — a mismatch is a real fraud signal, see `reportController.js`),
  an items-ordered breakdown, and a table of any blocked void/delete/edit
  attempts that day (who tried it, their role, their IP).
- **Orders** — every order for the selected date, any status. Each row has
  a **View** button opening a full breakdown (every item's temperature,
  removed ingredients, and extras, plus the true line-by-line total) and,
  for a voided order, exactly who voided it, their stated reason, and when.
  The **Void** button is the one place in the system that can actually
  call `DELETE /api/orders/:id` — it prompts for a reason, which gets
  stored on the order (`voidReason`) and in the audit log.
- **Staff** — every user account, with **Activate/Deactivate** toggles
  (a deactivated account can no longer log in, but its historical orders
  and audit trail stay intact — nothing is deleted) and an **Add Staff**
  button to create new waiter/barista/manager logins without touching the
  database directly.

A manager can't deactivate their own account (blocked server-side in
`userController.js`) — that's a deliberate guard against locking yourself
out.

## Notes on this build

- **No React/build step for the frontends** — `public/waiter`,
  `public/barista`, and `public/admin` are all plain HTML/CSS/JS served
  directly by Express via `express.static`, so there's nothing to compile.
- **Separate login sessions per screen** — the waiter, barista, and admin
  frontends each save their token under a different `localStorage` key
  (`kds_waiter_*`, `kds_barista_*`, `kds_admin_*`). Since all three are
  served from the same origin (`localhost:4000`), sharing one key would
  mean logging into one screen silently logs you into another with the
  wrong role — this is why the keys are kept separate.
- **Deactivated accounts are blocked at login**, not just at the route
  level — `authController.js`'s `login()` checks `isActive` before issuing
  a token, so a manager deactivating a waiter takes effect immediately for
  any new login, even if that waiter still has an old tab open with a
  still-valid token (there's no live token revocation built in here — worth
  adding if you need to cut off an active session immediately).
- **Socket.io auth** uses the same JWT as the HTTP API — see `src/socket.js`.
- **Audit logging** (`src/middleware/auditLogger.js`) records every order
  creation and every attempt (successful or blocked) to edit/void/delete an
  order, including who tried it and from what IP — this is what the daily
  report cross-checks against.
- **Prisma Studio** (`npx prisma studio`) is a quick way to browse the actual
  database tables while testing.
