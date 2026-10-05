// Demo used for the README screenshots: a payment flow with realistic (blocking) I/O delays.
function blockFor(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function validateOrder(order) {
  blockFor(2);
  return order.items.length > 0;
}

function queryDatabase(sku) {
  blockFor(7);
  return { sku, stock: 12 };
}

function checkInventory(order) {
  return order.items.map((sku) => queryDatabase(sku).stock);
}

function calculateTotal(order) {
  blockFor(1);
  return order.items.length * 19.99;
}

function chargeCard(orderId, total) {
  blockFor(843);
  return { success: true, orderId, total };
}

function sendReceipt(orderId) {
  blockFor(221);
  console.log('Receipt sent for order', orderId);
}

function processPayment(order) {
  console.log('Starting payment...');
  validateOrder(order);
  console.log('Checking inventory...');
  checkInventory(order);
  const total = calculateTotal(order);
  const result = chargeCard(order.orderId, total);
  sendReceipt(order.orderId);
  return result;
}

module.exports = { processPayment };
