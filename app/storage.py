"""文件数据库。

所有对 data/ 的读写都必须经过这里。写入路径统一是：
    fcntl 排他锁 → 读取 → 内存修改 → 临时文件 + fsync → os.replace 原子替换
即使进程被强杀也不会留下半截 JSON。

⚠️ 锁不可重入：同一路径的 mutate_* 不要嵌套调用（fcntl 对同一进程的
不同 fd 同样会阻塞）。跨不同文件（如 users.json 与某用户的 store.json）
嵌套是安全的。
"""

import copy
import errno
import fcntl
import json
import os
import re
import secrets
import shutil
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

from app import config
from app.errors import ApiError, conflict, not_found

LINK_TOKEN_RE = re.compile(r"^[A-Za-z0-9_\-]{16,64}$")

DEFAULT_STORE = {"rev": 0, "folders": [], "items": []}
DEFAULT_INBOX = {"shares": []}
DEFAULT_OUTBOX = {"shares": []}
DEFAULT_USERS = {"users": {}}
DEFAULT_CONFIG = {}


class NoChange(Exception):
    """在 mutate_* 块内抛出表示"本次没有真正修改"，不写回也不递增 rev。"""


# ── 底层 IO ──────────────────────────────────────────────

def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def read_json(path: Path, default):
    try:
        with open(path, "r", encoding="utf-8") as fp:
            return json.load(fp)
    except FileNotFoundError:
        return copy.deepcopy(default)
    except json.JSONDecodeError:
        # 文件损坏：留一份现场供排查，然后按默认值继续，避免整个服务卡死
        backup = path.with_name(f"{path.name}.corrupt.{int(time.time())}")
        try:
            shutil.copy2(path, backup)
        except OSError:
            pass
        return copy.deepcopy(default)


def write_json_atomic(path: Path, data) -> None:
    _ensure_dir(path.parent)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            json.dump(data, fp, ensure_ascii=False)
            fp.flush()
            os.fsync(fp.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


@contextmanager
def locked(path: Path):
    """对 path 加排他锁（锁在伴生的 .lock 文件上，避免锁住被替换的 inode）。"""
    lock_path = path.with_name(path.name + ".lock")
    _ensure_dir(lock_path.parent)
    handle = open(lock_path, "a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


@contextmanager
def mutate_json(path: Path, default):
    """加锁 → 读取 → yield 可变对象 → 原子写回。块内异常时不写回。"""
    with locked(path):
        data = read_json(path, default)
        try:
            yield data
        except NoChange:
            return
        write_json_atomic(path, data)


# ── ID ───────────────────────────────────────────────────

def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def new_uid() -> str:
    return secrets.token_hex(16)


def now() -> int:
    return int(time.time())


# ── 应用配置（含密钥，绝不外泄）────────────────────────────

def load_app_config() -> dict:
    return read_json(config.config_path(), DEFAULT_CONFIG)


@contextmanager
def mutate_app_config():
    with mutate_json(config.config_path(), DEFAULT_CONFIG) as data:
        yield data


def get_secret(name: str) -> bytes:
    """取出 jwt_secret / invite_secret 的字节形式。缺失说明没跑过 bootstrap。"""
    value = load_app_config().get(name)
    if not value:
        raise ApiError("internal_error", f"缺少 {name}，服务未正确初始化", 500)
    return bytes.fromhex(value) if _is_hex(value) else value.encode("utf-8")


def _is_hex(value: str) -> bool:
    try:
        bytes.fromhex(value)
        return True
    except ValueError:
        return False


def registration_open() -> bool:
    return bool(load_app_config().get("registration_open", False))


# ── 用户表 ───────────────────────────────────────────────

def load_users() -> dict:
    data = read_json(config.users_path(), DEFAULT_USERS)
    data.setdefault("users", {})
    return data


@contextmanager
def mutate_users():
    with mutate_json(config.users_path(), DEFAULT_USERS) as data:
        data.setdefault("users", {})
        yield data


def get_user(username: str) -> dict | None:
    """用户名大小写不敏感查找。返回完整记录（含 uid、pwd_hash）。"""
    if not isinstance(username, str) or not username:
        return None
    return load_users()["users"].get(username.lower())


def get_user_by_uid(uid: str) -> dict | None:
    for record in load_users()["users"].values():
        if record.get("uid") == uid:
            return record
    return None


def list_users() -> list[dict]:
    users = list(load_users()["users"].values())
    users.sort(key=lambda u: u.get("created_at", 0))
    return users


def list_uids() -> list[str]:
    return [u["uid"] for u in load_users()["users"].values() if u.get("uid")]


def create_user(username: str, pwd_salt: str, pwd_hash: str, role: str = "user") -> dict:
    key = username.lower()
    record = {
        "uid": new_uid(),
        "username": username,
        "pwd_salt": pwd_salt,
        "pwd_hash": pwd_hash,
        "role": role,
        "created_at": now(),
        "disabled": False,
        "token_version": 1,
    }
    with mutate_users() as data:
        if key in data["users"]:
            raise conflict("用户名已被占用")
        data["users"][key] = record
    init_user_files(record["uid"])
    return record


def update_user(username: str, **fields) -> dict:
    key = username.lower()
    with mutate_users() as data:
        record = data["users"].get(key)
        if record is None:
            raise not_found("用户不存在")
        record.update(fields)
        result = copy.deepcopy(record)
    return result


def bump_token_version(username: str) -> int:
    key = username.lower()
    with mutate_users() as data:
        record = data["users"].get(key)
        if record is None:
            raise not_found("用户不存在")
        record["token_version"] = int(record.get("token_version", 1)) + 1
        return record["token_version"]


def delete_user(username: str) -> str:
    """删除用户记录并移除其数据目录。返回被删用户的 uid。"""
    key = username.lower()
    with mutate_users() as data:
        record = data["users"].pop(key, None)
        if record is None:
            raise not_found("用户不存在")
        uid = record.get("uid", "")
    if uid:
        shutil.rmtree(user_dir(uid), ignore_errors=True)
    return uid


def public_user(record: dict) -> dict:
    """对外暴露的用户视图 —— 绝不包含 uid、密码哈希、token_version。"""
    return {
        "username": record.get("username", ""),
        "role": record.get("role", "user"),
        "created_at": record.get("created_at", 0),
    }


# ── 用户数据目录 ──────────────────────────────────────────

def user_dir(uid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{8,64}", uid or ""):
        raise ApiError("internal_error", "非法的用户目录标识", 500)
    return config.users_dir() / uid


def store_path(uid: str) -> Path:
    return user_dir(uid) / "store.json"


def inbox_path(uid: str) -> Path:
    return user_dir(uid) / "inbox.json"


def outbox_path(uid: str) -> Path:
    return user_dir(uid) / "outbox.json"


def init_user_files(uid: str) -> None:
    _ensure_dir(user_dir(uid))
    for path, default in (
        (store_path(uid), DEFAULT_STORE),
        (inbox_path(uid), DEFAULT_INBOX),
        (outbox_path(uid), DEFAULT_OUTBOX),
    ):
        if not path.exists():
            write_json_atomic(path, copy.deepcopy(default))


def load_store(uid: str) -> dict:
    data = read_json(store_path(uid), DEFAULT_STORE)
    data.setdefault("rev", 0)
    data.setdefault("folders", [])
    data.setdefault("items", [])
    return data


@contextmanager
def mutate_store(uid: str):
    """yield store dict；正常退出时 rev += 1 并原子写回。

    若本次实际没有改动，在块内 `raise storage.NoChange` —— 不写回、不递增 rev。
    """
    path = store_path(uid)
    with locked(path):
        data = read_json(path, DEFAULT_STORE)
        data.setdefault("rev", 0)
        data.setdefault("folders", [])
        data.setdefault("items", [])
        try:
            yield data
        except NoChange:
            return
        data["rev"] = int(data.get("rev", 0)) + 1
        write_json_atomic(path, data)


def load_inbox(uid: str) -> dict:
    data = read_json(inbox_path(uid), DEFAULT_INBOX)
    data.setdefault("shares", [])
    return data


@contextmanager
def mutate_inbox(uid: str):
    with mutate_json(inbox_path(uid), DEFAULT_INBOX) as data:
        data.setdefault("shares", [])
        yield data


def load_outbox(uid: str) -> dict:
    data = read_json(outbox_path(uid), DEFAULT_OUTBOX)
    data.setdefault("shares", [])
    return data


@contextmanager
def mutate_outbox(uid: str):
    with mutate_json(outbox_path(uid), DEFAULT_OUTBOX) as data:
        data.setdefault("shares", [])
        yield data


# ── 公开链接 ─────────────────────────────────────────────

def new_link_token() -> str:
    return secrets.token_urlsafe(24)


def link_path(token: str) -> Path:
    """token 先过字符集校验，杜绝 ../ 之类的路径穿越。"""
    if not isinstance(token, str) or not LINK_TOKEN_RE.match(token):
        raise not_found("链接不存在")
    return config.shares_dir() / f"{token}.json"


def load_link(token: str) -> dict | None:
    path = link_path(token)
    if not path.exists():
        return None
    return read_json(path, None)


def save_link(token: str, data: dict) -> None:
    write_json_atomic(link_path(token), data)


def delete_link(token: str) -> bool:
    path = link_path(token)
    lock = path.with_name(path.name + ".lock")
    existed = path.exists()
    path.unlink(missing_ok=True)
    lock.unlink(missing_ok=True)
    return existed


def list_links(owner_uid: str) -> list[dict]:
    directory = config.shares_dir()
    if not directory.exists():
        return []
    links = []
    for path in directory.glob("*.json"):
        data = read_json(path, None)
        if isinstance(data, dict) and data.get("owner_uid") == owner_uid:
            links.append(data)
    links.sort(key=lambda link: link.get("created_at", 0), reverse=True)
    return links


def delete_links_of(owner_uid: str) -> int:
    removed = 0
    directory = config.shares_dir()
    if not directory.exists():
        return 0
    for path in list(directory.glob("*.json")):
        data = read_json(path, None)
        if isinstance(data, dict) and data.get("owner_uid") == owner_uid:
            path.unlink(missing_ok=True)
            path.with_name(path.name + ".lock").unlink(missing_ok=True)
            removed += 1
    return removed


def ensure_dirs() -> None:
    for directory in (config.data_dir(), config.users_dir(), config.shares_dir()):
        try:
            _ensure_dir(directory)
        except OSError as exc:
            if exc.errno != errno.EEXIST:
                raise
