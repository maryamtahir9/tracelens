"""Example project used for TraceLens documentation and tests."""
import time


class PaymentError(Exception):
    pass


def validate_order(order):
    if not order.get("items"):
        raise ValueError("order has no items")
    return True


def check_inventory(order):
    time.sleep(0.015)
    return {item: 5 for item in order["items"]}


def calculate_price(order):
    return sum(order["items"].values())


def charge_card(order, total):
    time.sleep(0.06)
    if order.get("card") == "declined":
        raise PaymentError("card declined")
    return {"success": True, "total": total}


def send_confirmation(order):
    print("Sending confirmation for order", order["id"])
    time.sleep(0.02)


def process_order(order):
    print("Processing order", order["id"])
    validate_order(order)
    check_inventory(order)
    total = calculate_price(order)
    charge_card(order, total)
    send_confirmation(order)
    return total


def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)


def spin_forever():
    while True:
        pass


class OrderService:
    def total(self, items):
        return sum(items)


if __name__ == "__main__":
    process_order({"id": 7, "items": {"apple": 3, "pear": 2}})
