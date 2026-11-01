# Showcase Roadmap: Live Order Flow (Scan → Menu → Order → Kitchen)

## 0. Decision: which slice, and why

The recruiter wants **one portion of the project that includes frontend and backend**. Recommended slice: **"Live Order Flow"**.

| In scope (build) | Out of scope (mention as "next steps") |
|---|---|
| QR scan → table session | Redis cluster / socket scaling |
| Guest menu PWA (mobile) | ESC/POS thermal printing |
| Modifiers, cart, place order | Waiter terminal (only the socket events exist) |
| Live order tracking + cancel rule | Group cart sync, payments, billing UI |
| Kitchen Display (KDS) board with live tickets, timers, bump | Admin panel, analytics, Workbox offline |
| 86 (sold-out) toggle, live to every guest | |
| Staff JWT auth + role rules | |

Why this one: it is the heart of the spec, it needs every skill a recruiter looks for (REST design, relational modelling, auth, real-time, state machines, mobile-first UI, a second "dashboard-style" UI), and it is demo-able in 2 minutes. You already know the frontend half (Next.js, Tailwind, React, TS); the new parts (NestJS, Prisma, Socket.io, Postgres) are exactly what the backend teaches.

## 1. Session plan (sized for the free plan)

| Session | Goal | Status |
|---|---|---|
| **1 (done)** | Backend code: schema, auth, scan, menu, orders, state machine, 86, service alerts, sockets, unit tests, smoke test, README | ✅ written · ⚠ not run against a DB yet (see §2) |
| **2** | You run the backend locally → I fix anything the smoke test finds. Then Figma designs for the 6 screens (or you design from §4 checklists) | next |
| **3** | Guest PWA: scan, menu, item sheet, cart, order tracking, service buttons | |
| **4** | KDS: login, board, timers, bump keys, 86 panel | |
| **5** | Polish + deploy + README/demo video + interview talking points | |

Each session is small on purpose: one vertical chunk, tested, committed.

## 2. Your homework before session 2 (≈20 minutes)

My sandbox could not download Prisma's database engines (its network policy blocks `binaries.prisma.sh`), so I verified the pure logic (13 unit tests pass) but could **not** boot the API against Postgres. Your machine will not have that limit. Follow `README.md` → Quick start, then run `node test/smoke.mjs`. Paste back either "all passed" or the first failing line and I will fix it. Expect a few small type errors on the first `npm run start:dev`, which is normal for code written before the client was generated.

## 3. Backend reading guide (what you should be able to explain)

Open files in this order; each is short.

1. `prisma/schema.prisma`: spec DDL + marked `[ADDED]` tables (`TableSession`, `StaffUser`, void/served columns).
2. `src/common/order-state.ts`: the state machine (spec §5). Pure function, easy to explain, unit-tested.
3. `src/common/pricing.ts`: server-side money maths with `Decimal`.
4. `src/auth/*`: two JWT families, guards, `@Roles()`.
5. `src/tables/tables.module.ts`: scan → session. Note the race-safe session creation.
6. `src/orders/orders.service.ts`: the core: re-pricing, order numbers, compare-and-swap status updates, table release, fan-out to rooms.
7. `src/realtime/realtime.gateway.ts`: rooms and handshake auth.

**Deviations from the spec (say these out loud in the interview, they show judgement):**

| Spec | What I did | Why |
|---|---|---|
| `table_id` in order body | derived from session token | client can't order onto another table |
| client sends modifier `cost` | client sends `{name, option}`; cost looked up | client can't set prices |
| "Table Session Token" undefined | `TableSession` row + JWT | new party can't see last party's orders; token dies on CLOSED |
| no users table | `StaffUser` + roles | JWT roles need a source |
| order has one `courseType` | each item has `courseType` + `station` | one order can span Hot/Cold/Bar |
| Redis in stack | not used in slice | one instance doesn't need it; listed as next step |

## 4. Frontend plan: pages and what each needs

Folder: a separate Next.js app (`restaurant-web`, Next 14+ App Router, Tailwind, TypeScript). Suggested libs: `socket.io-client`, `zustand` (cart + session), `@tanstack/react-query` (fetching), `clsx`.

Design language: warm, appetising, mobile-first for guests (large tap targets ≥ 44px, one-hand reachable actions at the bottom). KDS: dark, high-contrast, readable from 1.5 m away on a tablet/TV.

### Guest app (mobile, 390 × 844)

**G1. `/scan/[token]`: Splash / resolving**
- Shows: restaurant name, "Setting up Table 4…", spinner. Error variants: *invalid QR*, *network error + retry*.
- Data: `GET /table/scan/:token` → store `sessionToken`, restaurant, table. Redirect to `/menu`.

**G2. `/menu`: Menu browsing**
- Header: restaurant name, table badge ("Table 4"), small connection dot.
- Sticky horizontal category tabs (Starters, Main Course…) with scroll-spy.
- Filters: Veg / Non-veg / Vegan chip; text search.
- Item card: name, 2-line description, price, dietary dot (green/red/vegan leaf), allergen chips, photo slot (placeholder ok), **Sold out** state (greyed, not tappable), "+" quick add if no required modifiers.
- Sticky bottom cart bar: "2 items · ₹560 · View cart".
- Live: `menu:item_availability` flips a card to sold out without reload.

**G3. Item sheet (bottom sheet over `/menu`)**
- Image, name, description, allergens.
- One radio group per modifier group (required ones marked, price delta shown, e.g. "Hot +₹10").
- Quantity stepper (1–20), notes textarea (200 chars, counter).
- Button: "Add to cart · ₹420" (updates live with options/qty). Disabled until required groups are chosen.

**G4. `/cart`**
- Lines with modifiers + notes, qty stepper, remove (swipe or button).
- Totals box: subtotal, tax %, service %, total (labelled "estimated"; server value wins).
- Primary button "Place order". States: submitting, success (→ `/orders`), error list (e.g. "Fresh Lime Soda is sold out", with the line highlighted).

**G5. `/orders`: Track & service**
- Per order card: order number, time, items, total, status stepper (Placed → Accepted → Preparing → Served), live via `order:status_changed`.
- "Cancel order" button, **only enabled while PLACED**; after that shows "Kitchen has started. Ask your waiter".
- Cancelled orders show reason. On SERVED: gentle "Enjoy your meal" and a "Order more" button.
- Floating "Need something?" sheet: Call waiter · Water/refill · Request bill (each with cooldown feedback on 429).
- On `table:released`: thank-you screen, clear session.

### Staff app (tablet landscape, 1280 × 800, dark)

**S1. `/kds/login`:** email, password, error state, role shown after login.

**S2. `/kds`: Kitchen board**
- Top bar: station tabs **All · Hot · Cold · Bar**, live connection indicator, sound toggle, clock, "86 items" button.
- Columns: **New (PLACED)** · **In progress (ACCEPTED/PREPARING)**.
- Ticket card: order number, table, age timer (green < 5 min, amber 5–10, red > 10; counts from `placedAt`), items with qty, modifiers and prep notes highlighted, only items for the selected station.
- Actions: Accept → Start preparing → Mark served. Keyboard: arrow keys select a ticket, **Enter/Space** advances it (spec's "bump bar").
- New order: highlight flash + short beep.
- Reconnect: refetch `/orders/kds/active` after a socket reconnect.

**S3. 86 panel (drawer on `/kds`)**
- Items grouped by category with a big toggle each; instantly reflected on all guest phones.

### If you design it yourself in Figma
Create one frame per screen above plus: one variant per state noted (sold-out, error, disabled button, timer colours), a 6-colour palette, 2 fonts, 4 spacing sizes. In session 2 I will also try to generate these directly into a Figma file using the Figma connector; if that is not available on your account, use the lists above.

## 5. Step-by-step (frontend build order for sessions 3–4)

1. `npx create-next-app@latest restaurant-web --ts --tailwind --app`.
2. `lib/api.ts`: typed fetch wrapper with Bearer token; `types.ts` mirroring the order/menu JSON in the README (one `Order` type for REST + sockets).
3. `lib/socket.ts`: singleton `io()` with `auth: { token }`; hook `useSocketEvent(name, handler)`.
4. `store/session.ts` (zustand, persisted in `sessionStorage`) + `store/cart.ts`.
5. G1 scan page → G2 menu (static first, then live 86) → G3 sheet → G4 cart → G5 orders.
6. Staff: login → KDS board (REST first paint, then socket) → bump keys → 86 drawer.
7. PWA bits: `manifest.webmanifest`, icons, theme colour. (Skip Workbox offline unless time allows.)
8. Test the full demo with two browser windows: phone-sized guest + wide KDS.

## 6. Finish line: what the recruiter sees

- Repo(s) with a README that has: 1-paragraph pitch, architecture sketch, GIF of guest ordering while KDS updates, quick start, "design decisions" list (copy from backend README), "next steps".
- Live demo (Vercel for web, Render/Railway for API, Neon for Postgres).
- A 2-minute screen recording: scan → order → ticket appears on KDS → accept → guest sees status → 86 an item.
- Talking points: server-side pricing, session model, state machine + compare-and-swap, room-based sockets, rate limiting, what you cut and why.

## 7. Pending from session 1

- [ ] Run backend locally + smoke test (you) → fix findings (me)
- [ ] Figma screens (or your own designs)
- [ ] Guest PWA, KDS UI, deploy, README polish
- [ ] Optional stretch: Redis socket adapter, signed rotating QR tokens, waiter terminal
