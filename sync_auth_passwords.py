import base64
import os
from typing import Optional

from dotenv import load_dotenv
import firebase_admin
from firebase_admin import credentials, db, auth


def _decode_with_key(encrypted: str, key: str) -> Optional[str]:
    try:
        decoded = base64.b64decode(encrypted).decode("utf-8")
    except Exception:
        return None

    if decoded.endswith(key):
        return decoded[: -len(key)]
    return None


def resolve_password(stored_value: str, env_key: str) -> Optional[str]:
    if not stored_value:
        return None

    candidates = []
    if env_key:
        candidates.append(env_key)
    candidates.append("default-key")

    for key in candidates:
        pw = _decode_with_key(stored_value, key)
        if pw:
            return pw

    # If it is not base64+key format, assume plain text fallback.
    return stored_value


def main() -> None:
    load_dotenv()

    service_account_path = os.getenv("FIREBASE_SERVICE_ACCOUNT", "firebase-service-account.json")
    database_url = os.getenv("FIREBASE_DATABASE_URL", "").strip()
    encryption_key = os.getenv("ENCRYPTION_KEY", "").strip()

    if not os.path.exists(service_account_path):
        raise FileNotFoundError(f"Service account file not found: {service_account_path}")
    if not database_url:
        raise RuntimeError("FIREBASE_DATABASE_URL missing in .env")

    if not firebase_admin._apps:
        cred = credentials.Certificate(service_account_path)
        firebase_admin.initialize_app(cred, {"databaseURL": database_url})

    users_ref = db.reference("users")
    users = users_ref.get() or {}

    if not isinstance(users, dict) or not users:
        print("No users found in Realtime Database.")
        return

    created = 0
    updated = 0
    skipped = 0
    failed = 0

    for username, payload in users.items():
        if not isinstance(payload, dict):
            skipped += 1
            continue

        username = str(username).strip().lower()
        email = f"{username}@zentiq.local"
        stored_password = str(payload.get("password", "")).strip()
        resolved_password = resolve_password(stored_password, encryption_key)

        if not username or not resolved_password:
            skipped += 1
            print(f"SKIP {username or '<empty>'}: missing usable password")
            continue

        try:
            try:
                user_record = auth.get_user_by_email(email)
                auth.update_user(user_record.uid, password=resolved_password)
                updated += 1
                print(f"UPDATED {email}")
            except auth.UserNotFoundError:
                auth.create_user(email=email, password=resolved_password)
                created += 1
                print(f"CREATED {email}")
        except Exception as exc:
            failed += 1
            print(f"FAIL {email}: {exc}")

    print("\nDone")
    print(f"created={created}, updated={updated}, skipped={skipped}, failed={failed}")


if __name__ == "__main__":
    main()
