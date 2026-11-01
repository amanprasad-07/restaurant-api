// End-to-end smoke test against a RUNNING API (npm run start:dev) with seeded data (npm run db:seed).
// Usage: node test/smoke.mjs        (API_URL defaults to http://localhost:4000)
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const BASE = `${API}/api/v1`;
let failures = 0;

const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const login = async (role) =>
  (await call('POST', '/auth/staff/login', { body: { email: `${role}@demobistro.test`, password: 'Password123!' } })).json
    .accessToken;

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io(API, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });

const waitFor = (socket, event, ms = 2000) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    socket.once(event, (p) => { clearTimeout(t); resolve(p); });
  });

const chef = await login('chef');
const waiter = await login('waiter');
const captain = await login('captain');
check('staff login works', !!chef && !!waiter && !!captain);
check('wrong password is rejected', (await call('POST', '/auth/staff/login', { body: { email: 'chef@demobistro.test', password: 'wrong-password' } })).status === 401);

const kdsSocket = await connect(chef);

// 1. Scan the QR
const scan = await call('GET', '/table/scan/demo-table-1');
check('scan returns a session token', scan.status === 200 && !!scan.json.sessionToken);
const guest = scan.json.sessionToken;
const restaurantId = scan.json.restaurant.id;
const guestSocket = await connect(guest);
check('unknown QR token -> 404', (await call('GET', '/table/scan/does-not-exist')).status === 404);

// 2. Menu
const menu = await call('GET', `/menu/dine-in/${restaurantId}`, { token: guest });
const items = menu.json.flatMap((c) => c.items);
const byName = (n) => items.find((i) => i.name === n);
check('menu loads with categories', menu.status === 200 && menu.json.length >= 4);
check('menu without a token -> 401', (await call('GET', `/menu/dine-in/${restaurantId}`)).status === 401);

// 3. Place an order
const chicken = byName('Butter Chicken');
const kdsPromise = waitFor(kdsSocket, 'kds:new_order');
const t0 = Date.now();
const placed = await call('POST', '/orders/dine-in', {
  token: guest,
  body: { items: [{ menuItemId: chicken.id, quantity: 2, price: 1, modifiers: [{ name: 'Spice Level', option: 'Medium' }], prepNotes: 'Less salt' }] },
});
check('order created', placed.status === 201, placed.json?.orderNumber);
check('total computed server-side (2 x 420 + 5% + 5% = 924)', placed.json?.totalAmount === 924, `got ${placed.json?.totalAmount}`);
const kdsEvent = await kdsPromise;
check('KDS received kds:new_order', kdsEvent?.id === placed.json?.id, kdsEvent ? `${Date.now() - t0}ms` : 'timed out');
check('missing required modifier -> 400', (await call('POST', '/orders/dine-in', { token: guest, body: { items: [{ menuItemId: chicken.id, quantity: 1 }] } })).status === 400);

// 4. Kitchen flow + guards
const id = placed.json.id;
check('cannot skip PLACED -> SERVED', (await call('PATCH', `/orders/${id}/status`, { token: chef, body: { status: 'SERVED' } })).status === 409);
check('waiter cannot accept', (await call('PATCH', `/orders/${id}/status`, { token: waiter, body: { status: 'ACCEPTED' } })).status === 403);
const guestSees = waitFor(guestSocket, 'order:status_changed');
check('chef accepts', (await call('PATCH', `/orders/${id}/status`, { token: chef, body: { status: 'ACCEPTED' } })).json?.status === 'ACCEPTED');
check('guest got live status update', (await guestSees)?.status === 'ACCEPTED');
check('guest can no longer cancel after ACCEPTED', (await call('POST', `/orders/${id}/cancel`, { token: guest })).status === 409);
check('voiding ACCEPTED needs a reason', (await call('PATCH', `/orders/${id}/status`, { token: captain, body: { status: 'CANCELLED' } })).status === 400);
check('chef -> PREPARING', (await call('PATCH', `/orders/${id}/status`, { token: chef, body: { status: 'PREPARING' } })).json?.status === 'PREPARING');
check('chef -> SERVED', (await call('PATCH', `/orders/${id}/status`, { token: chef, body: { status: 'SERVED' } })).json?.status === 'SERVED');

// 5. 86 an item
const lime = byName('Fresh Lime Soda');
const menuEvent = waitFor(guestSocket, 'menu:item_availability');
check('chef 86s an item', (await call('PATCH', `/menu/items/${lime.id}/86`, { token: chef, body: { isAvailable: false } })).status === 200);
check('guests get the 86 broadcast', (await menuEvent)?.isAvailable === false);
check('ordering an 86ed item -> 409', (await call('POST', '/orders/dine-in', { token: guest, body: { items: [{ menuItemId: lime.id, quantity: 1 }] } })).status === 409);
await call('PATCH', `/menu/items/${lime.id}/86`, { token: chef, body: { isAvailable: true } }); // restore

// 6. Service alerts
const bell = waitFor(kdsSocket, 'waiter:call_bell', 800); // chef is also in the floor room
check('call waiter works', (await call('POST', '/table/service-alert', { token: guest, body: { requestType: 'WATER' } })).status === 201);
check('floor got waiter:call_bell', (await bell)?.requestType === 'WATER');
check('alert spam is rate limited', (await call('POST', '/table/service-alert', { token: guest, body: { requestType: 'WATER' } })).status === 429);

// 7. Pay & close => session dies, table released
const released = waitFor(guestSocket, 'table:released');
check('waiter closes the order', (await call('PATCH', `/orders/${id}/status`, { token: waiter, body: { status: 'CLOSED' } })).json?.status === 'CLOSED');
check('guest told the table was released', !!(await released));
check('old session token is now dead', (await call('GET', `/menu/dine-in/${restaurantId}`, { token: guest })).status === 401);

kdsSocket.close();
guestSocket.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
