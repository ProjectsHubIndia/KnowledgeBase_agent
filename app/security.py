"""Password hashing and JWT issuing/verification.

Passwords use stdlib PBKDF2-HMAC-SHA256 (no extra dependency) stored in the
familiar ``pbkdf2_sha256$<iterations>$<salt>$<hash>`` form. Tokens are plain
HS256 JWTs carrying the user id, username and role.
"""

import base64
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

import jwt

from app.config import settings

_ALGORITHM = "HS256"
_ITERATIONS = 240_000


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), salt, _ITERATIONS
    )
    return "$".join(
        [
            "pbkdf2_sha256",
            str(_ITERATIONS),
            base64.b64encode(salt).decode(),
            base64.b64encode(digest).decode(),
        ]
    )


def verify_password(password: str, stored: str) -> bool:
    """Constant-time check of a password against a stored hash."""
    try:
        scheme, iterations, salt_b64, digest_b64 = stored.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        expected = base64.b64decode(digest_b64)
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), base64.b64decode(salt_b64), int(iterations)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def create_token(user_id: str, username: str, role: str) -> str:
    """Issue an access token for a user. Expires after settings.jwt_ttl_hours."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "username": username,
        "role": role,
        "iat": now,
        "exp": now + timedelta(hours=settings.jwt_ttl_hours),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=_ALGORITHM)


def decode_token(token: str) -> dict | None:
    """Verified claims, or None if the token is invalid/expired/tampered."""
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[_ALGORITHM])
    except jwt.PyJWTError:
        return None
