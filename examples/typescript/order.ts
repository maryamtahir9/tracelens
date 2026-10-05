// Example project used for TraceLens documentation and tests.
interface Order {
  id: number;
  items: Record<string, number>;
  card?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function validateOrder(order: Order): boolean {
  if (Object.keys(order.items).length === 0) {
    throw new Error('order has no items');
  }
  return true;
}

export async function checkInventory(order: Order): Promise<string[]> {
  await sleep(15);
  return Object.keys(order.items);
}

export function calculatePrice(order: Order): number {
  return Object.values(order.items).reduce((a, b) => a + b, 0);
}

export async function chargeCard(order: Order, total: number): Promise<{ success: boolean; total: number }> {
  await sleep(60);
  if (order.card === 'declined') {
    throw new Error('card declined');
  }
  return { success: true, total };
}

export function sendConfirmation(order: Order): void {
  console.log('Sending confirmation for order', order.id);
}

export async function processOrder(order: Order): Promise<number> {
  console.log('Processing order', order.id);
  validateOrder(order);
  await checkInventory(order);
  const total = calculatePrice(order);
  await chargeCard(order, total);
  sendConfirmation(order);
  return total;
}
