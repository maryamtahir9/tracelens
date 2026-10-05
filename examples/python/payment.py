"""Demo used for the README screenshots: a payment flow that fails while talking to the database."""
import time


def connect_database():
    time.sleep(0.03)
    raise ConnectionError("Failed to connect to database")


def fetch_user(user_id):
    connect_database()
    return {"id": user_id}


def validate_order(order):
    time.sleep(0.002)
    fetch_user(order["user"])
    return True


def process_payment(order):
    print("Starting payment...")
    print("Validating order...")
    validate_order(order)
    print("Checking inventory...")
