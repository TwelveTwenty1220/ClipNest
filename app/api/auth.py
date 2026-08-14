"""认证 API —— 见 docs/API.md 第 3 节。"""

from flask import Blueprint, g, jsonify, request

from app import invite, security, storage, validators
from app.errors import ApiError, unauthorized

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

# 用户不存在与密码错误必须返回一模一样的错误，否则登录接口就成了用户名探测器
BAD_CREDENTIALS = "用户名或密码错误"


def _body() -> dict:
    return validators.body(request.get_json(silent=True))


def _session(record: dict, status: int = 200):
    """签发 token 并附上对外用户视图。record 必须是最新的用户记录（tv 要准）。"""
    return jsonify({
        "token": security.issue_token(record),
        "user": storage.public_user(record),
    }), status


@bp.post("/register")
def register():
    data = _body()

    if not storage.registration_open():
        raise ApiError("registration_closed", "注册已关闭，请联系管理员")
    if not invite.verify_code(data.get("invite_code")):
        raise ApiError("invalid_invite", "邀请码错误或已过期")

    username = validators.validate_username(data.get("username"))
    password = validators.validate_password(data.get("password"))

    salt, digest = security.hash_password(password)
    record = storage.create_user(username, salt, digest)  # 重名时自己抛 conflict
    return _session(record, 201)


@bp.post("/login")
def login():
    data = _body()
    username = data.get("username") if isinstance(data.get("username"), str) else ""

    security.check_login_rate(username)

    record = storage.get_user(username)
    if record is None or not security.verify_password(
        data.get("password") if isinstance(data.get("password"), str) else "",
        record.get("pwd_salt", ""),
        record.get("pwd_hash", ""),
    ):
        # 两条分支共用一个出口，连计时差异也尽量抹平（不存在的用户不做哈希，
        # 但限流已经把爆破成本抬到足够高，不再额外做假哈希）
        security.record_login_failure(username)
        raise unauthorized(BAD_CREDENTIALS)

    if record.get("disabled"):
        # 密码已经对上了，说明是账号本人，如实告知比含糊的 401 体验好
        raise ApiError("forbidden", "账号已被禁用")

    security.clear_login_failures(username)
    return _session(record)


@bp.get("/me")
@security.require_auth
def me():
    return jsonify({"user": storage.public_user(g.user)})


@bp.post("/password")
@security.require_auth
def change_password():
    data = _body()
    user = g.user

    if not security.verify_password(
        data.get("old_password") if isinstance(data.get("old_password"), str) else "",
        user.get("pwd_salt", ""),
        user.get("pwd_hash", ""),
    ):
        raise unauthorized("原密码错误")

    new_password = validators.validate_password(data.get("new_password"), label="新密码")
    salt, digest = security.hash_password(new_password)

    # update_user 与 bump_token_version 各自会锁 users.json，fcntl 锁不可重入，
    # 只能先后调用；随后重新取一次记录，保证签发的 token 带的是新 tv
    storage.update_user(user["username"], pwd_salt=salt, pwd_hash=digest)
    storage.bump_token_version(user["username"])
    record = storage.get_user(user["username"])

    return jsonify({"token": security.issue_token(record)})
