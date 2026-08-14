"""密码哈希、JWT 签发与校验、认证装饰器。见 docs/API.md 第 10 节。"""

import functools
import hashlib
import hmac
import secrets
import time

import jwt
from flask import g, request

from app import config, storage
from app.errors import ApiError, forbidden, unauthorized

SCRYPT_N = 16384
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32
SALT_BYTES = 16
JWT_ALG = "HS256"


# ── 密码 ─────────────────────────────────────────────────

def hash_password(password: str) -> tuple[str, str]:
    """返回 (salt_hex, hash_hex)。"""
    salt = secrets.token_bytes(SALT_BYTES)
    digest = _scrypt(password, salt)
    return salt.hex(), digest.hex()


def verify_password(password: str, salt_hex: str, hash_hex: str) -> bool:
    if not isinstance(password, str) or not salt_hex or not hash_hex:
        return False
    try:
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except ValueError:
        return False
    return hmac.compare_digest(_scrypt(password, salt), expected)


def _scrypt(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=SCRYPT_DKLEN,
        maxmem=64 * 1024 * 1024,
    )


def random_password(length: int = 16) -> str:
    """管理员重置密码用；去掉易混淆字符，方便口头/手抄传递。"""
    alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


# ── JWT ──────────────────────────────────────────────────

def issue_token(user: dict) -> str:
    payload = {
        "uid": user["uid"],
        "username": user["username"],
        "role": user.get("role", "user"),
        "tv": int(user.get("token_version", 1)),
        "iat": int(time.time()),
        "exp": int(time.time()) + config.token_days() * 86400,
    }
    return jwt.encode(payload, storage.get_secret("jwt_secret"), algorithm=JWT_ALG)


def decode_token(token: str) -> dict:
    """校验签名与过期时间。不校验 token_version —— 那是 require_auth 的事。"""
    try:
        return jwt.decode(token, storage.get_secret("jwt_secret"), algorithms=[JWT_ALG])
    except jwt.ExpiredSignatureError:
        raise unauthorized("登录已过期，请重新登录") from None
    except jwt.InvalidTokenError:
        raise unauthorized("登录凭证无效") from None


def _authenticate() -> dict:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise unauthorized()
    payload = decode_token(header[7:].strip())

    user = storage.get_user(payload.get("username", ""))
    if user is None or user.get("uid") != payload.get("uid"):
        raise unauthorized("登录凭证无效")
    if user.get("disabled"):
        raise forbidden("账号已被禁用")
    if int(payload.get("tv", -1)) != int(user.get("token_version", 1)):
        # 改过密码 / 被管理员重置或禁用过 —— 旧 token 一律作废
        raise unauthorized("登录已失效，请重新登录")
    return user


def require_auth(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        g.user = _authenticate()
        return fn(*args, **kwargs)

    return wrapper


def require_admin(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        user = _authenticate()
        if user.get("role") != "admin":
            raise forbidden("需要管理员权限")
        g.user = user
        return fn(*args, **kwargs)

    return wrapper


# ── 登录限流（进程内，重启即清空，对私有小工具够用）──────────

_FAIL_WINDOW = 60
_FAIL_LIMIT = 5
_failures: dict[str, list[float]] = {}


def check_login_rate(username: str) -> None:
    key = (username or "").lower()
    now = time.time()
    hits = [t for t in _failures.get(key, []) if now - t < _FAIL_WINDOW]
    _failures[key] = hits
    if len(hits) >= _FAIL_LIMIT:
        raise ApiError("rate_limited", "登录失败次数过多，请稍后再试", 429)


def record_login_failure(username: str) -> None:
    key = (username or "").lower()
    _failures.setdefault(key, []).append(time.time())


def clear_login_failures(username: str) -> None:
    _failures.pop((username or "").lower(), None)
