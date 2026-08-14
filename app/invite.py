"""时间轮换邀请码。

code = base32_custom(HMAC-SHA256(invite_secret, floor(now / 600)))[:8]

不落盘、不需要清理，重启也不影响。校验时同时接受当前窗口与上一个窗口，
避免有人正好在切换瞬间提交而失败。
"""

import hashlib
import hmac
import time

from app import storage

INVITE_PERIOD = 600  # 秒
# Crockford Base32：去掉 I L O U，避免 1/I、0/O 这类手抄错误
INVITE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
INVITE_LEN = 8


def _code_for_window(window: int) -> str:
    mac = hmac.new(
        storage.get_secret("invite_secret"),
        str(window).encode("ascii"),
        hashlib.sha256,
    ).digest()
    number = int.from_bytes(mac[:8], "big")
    chars = []
    for _ in range(INVITE_LEN):
        chars.append(INVITE_ALPHABET[number % len(INVITE_ALPHABET)])
        number //= len(INVITE_ALPHABET)
    return "".join(chars)


def _current_window(at: float | None = None) -> int:
    return int((at if at is not None else time.time()) // INVITE_PERIOD)


def current_code() -> str:
    return _code_for_window(_current_window())


def code_expires_in() -> int:
    """当前码的剩余有效秒数。"""
    return INVITE_PERIOD - int(time.time()) % INVITE_PERIOD


def normalize(code) -> str:
    if not isinstance(code, str):
        return ""
    return code.strip().replace("-", "").replace(" ", "").upper()


def verify_code(code) -> bool:
    """接受当前窗口与上一窗口；大小写不敏感，忽略空格与连字符。"""
    candidate = normalize(code)
    if len(candidate) != INVITE_LEN:
        return False
    window = _current_window()
    return any(
        hmac.compare_digest(candidate, _code_for_window(w))
        for w in (window, window - 1)
    )
