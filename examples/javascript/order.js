// Example project used for TraceLens documentation and tests.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function validateOrder(order) {
  if (!order.items || Object.keys(order.items).length === 0) throw new Error('order has no items');
  return true;
}

async function checkInventory(order) {
  await sleep(15);
  return Object.keys(order.items);
}

function calculatePrice(order) {
  return Object.values(order.items).reduce((a, b) => a + b, 0);
}

async function chargeCard(order, total) {
  await sleep(60);
  if (order.card === 'declined') throw new Error('card declined');
  return { success: true, total };
}

function sendConfirmation(order) {
  console.log('Sending confirmation for order', order.id);
}

async function processOrder(order) {
  console.log('Processing order', order.id);
  validateOrder(order);
  await checkInventory(order);
  const total = calculatePrice(order);
  await chargeCard(order, total);
  sendConfirmation(order);
  return total;
}

const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2));

function spinForever() {
  for (;;) { /* never returns */ }
}

class OrderService {
  total(items) { return items.reduce((a, b) => a + b, 0); }
  static label() { return 'orders'; }
}

module.exports = { processOrder, fib, OrderService, spinForever };
