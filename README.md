# Restaurant QR Ordering API

Guests scan a QR code on their table, browse the menu, and order. The kitchen sees each order appear live on a KDS screen and moves it through the order lifecycle. Built as a portfolio slice of a larger restaurant-platform spec.

**Stack:** NestJS · TypeScript · PostgreSQL · Prisma · Socket.io · JWT · class-validator · Swagger

## The slice

```
QR scan ─► table session (JWT) ─► menu ─► place order ─► KDS (live) ─► PLACED→ACCEPTED→PREPARING→SERVED→CLOSED
                                    │                       │
                                    └── 86 an item ─────────┴── broadcast to every guest instantly
```

## Quick start

Requires Node 20+ and Docker (or any local PostgreSQL 15+).

```bash
docker compose up -d postgres          # redis is not needed for this slice
npm install
cp .env.example .env                   # then replace the two JWT secrets (command is in the file)

# 1) create the migration without applying it
npx prisma migrate dev --create-only --name init
# 2) append the partial unique index to the generated migration.sql
cat prisma/sql/one_open_session_per_table.sql >> prisma/migrations/*_init/migration.sql
# 3) apply + generate client
npx prisma migrate dev

npm run db:seed                        # demo restaurant, 6 tables, 8 dishes, 4 staff users
npm run start:dev                      # API http://localhost:4000/api/v1  ·  Swagger http://localhost:4000/docs
```

Verify everything end to end (API must be running):

```bash
npm test                               # unit tests (state machine, pricing)
node test/smoke.mjs                    # 27 live checks incl. WebSocket events (login is rate-limited to 5/min, so wait a minute between runs)
```

Demo logins (dev only): `chef@demobistro.test`, `captain@demobistro.test`, `waiter@demobistro.test`, `admin@demobistro.test` — password `Password123!`.
Demo QR tokens: `demo-table-1` … `demo-table-4`, `demo-patio-1`, `demo-bar-seat-1`.

## REST API (`/api/v1`)

| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/staff/login` | public (5/min) | email + password → staff JWT |
| GET | `/table/scan/:token` | public (30/min) | resolve QR → start/join table session, returns `sessionToken`, restaurant, table, existing orders |
| GET | `/menu/dine-in/:restaurantId` | table | categories → items (incl. sold-out flag, modifier groups) |
| POST | `/orders/dine-in` | table | place order `{ items: [{ menuItemId, quantity, modifiers, prepNotes }] }` |
| GET | `/orders/dine-in/session` | table | all orders of this party |
| POST | `/orders/:id/cancel` | table | guest cancel, only while `PLACED` |
| POST | `/table/service-alert` | table | `{ requestType: CALL_WAITER \| WATER \| BILL }` (30 s cooldown) |
| GET | `/orders/kds/active?station=HOT` | staff (chef/admin/captain) | kitchen queue for first paint |
| PATCH | `/orders/:id/status` | staff | state-machine transition, role-checked |
| PATCH | `/menu/items/:id/86` | staff (admin/chef) | `{ isAvailable }` live sold-out toggle |

## Realtime (Socket.io)

Connect with `io(API_URL, { auth: { token } })`. Guest tokens join `room:table:{id}` + `room:menu:{restaurantId}`; staff tokens join `room:kds:{restaurantId}` + `room:floor:{restaurantId}`.

| Event (server → client) | Room | Payload |
|---|---|---|
| `kds:new_order` | kds | full order |
| `order:status_changed` | table, kds, floor | full order |
| `table:order_created` | table | full order (other phones at the table) |
| `table:released` | table | `{ tableId }` – bill paid, session ended |
| `menu:item_availability` | menu | `{ itemId, isAvailable }` |
| `waiter:call_bell` | floor | `{ tableId, tableNumber, requestType, timestamp }` |
| `floor:table_status` | floor | `{ tableId, tableNumber, status }` |

Client → server: `table:order_submit` (same body as the REST order) returns an ack `{ ok, order | error }`.

## Design decisions worth talking about

- **Server is the source of truth for money.** Clients send item ids + chosen options only; prices, modifier costs, tax and service charge are computed server-side with `Decimal` (never floats) and snapshotted on `order_items`.
- **Table identity comes from the token, never the request body.** The spec's `table_id` in the order body is dropped, so a guest can't order onto another table.
- **Table sessions.** First scan of a vacant table opens a `TableSession`; later scans join it (group ordering); closing the last open order ends it, kills the token and frees the table. A partial unique index makes concurrent first scans race-safe.
- **State machine as a pure function** with role rules and a compare-and-swap `updateMany` so two staff tapping at once cannot both win.
- **Two JWT families, two secrets** (guest vs staff); guest tokens are also checked against the live session row.
- **Rate limits** on login, scan, order and service-alert spam.

## Known gaps (deliberate, for the slice)

Redis adapter for multi-instance sockets · signed/rotating QR tokens (a photo of a QR currently opens a session) · ESC/POS ticket printing · waiter terminal UI · payments · refresh tokens · audit log.
