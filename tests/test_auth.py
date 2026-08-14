"""认证 API 测试 —— 对照 docs/API.md 第 3 节。"""

import pytest

from tests.conftest import ApiClient, err, ok

PASSWORD = "password123"
USER_KEYS = {"username", "role", "created_at"}


def register(client, username="newbie", password=PASSWORD, code=None):
    return client.post(
        "/api/auth/register",
        json={"username": username, "password": password, "invite_code": code},
    )


def disable(app, username: str) -> None:
    from app import storage

    with app.app_context():
        storage.update_user(username, disabled=True)


# ── 注册 ─────────────────────────────────────────────────

def test_register_returns_usable_token(client, anon, open_registration, invite_code):
    payload = ok(register(client, "xinkun", code=invite_code), 201)
    assert payload["user"] == {
        "username": "xinkun",
        "role": "user",
        "created_at": payload["user"]["created_at"],
    }

    fresh = ApiClient(client, payload["token"], "xinkun")
    assert ok(fresh.get("/api/auth/me"))["user"]["username"] == "xinkun"


def test_register_blocked_when_closed(client, invite_code):
    """registration_open 默认关闭，邀请码正确也不放行。"""
    err(register(client, code=invite_code), "registration_closed", 403)


def test_register_rejects_bad_invite(client, open_registration, invite_code):
    for code in ("BADCODE1", "", None, invite_code + "X"):
        err(register(client, code=code), "invalid_invite", 400)


def test_register_accepts_previous_window_code(app, client, open_registration):
    """窗口刚好在提交瞬间翻页时不该把人挡在门外。"""
    from app import invite

    with app.app_context():
        previous = invite._code_for_window(invite._current_window() - 1)
    ok(register(client, "windowed", code=previous), 201)


def test_register_conflict_is_case_insensitive(client, open_registration, invite_code):
    ok(register(client, "alice", code=invite_code), 201)
    err(register(client, "ALICE", code=invite_code), "conflict", 409)
    err(register(client, "alice", code=invite_code), "conflict", 409)


@pytest.mark.parametrize("username", ["ab", "用户名", "has space", "", "a" * 33, "bad!name"])
def test_register_rejects_bad_username(client, open_registration, invite_code, username):
    err(register(client, username, code=invite_code), "validation_error", 400)


@pytest.mark.parametrize("password", ["short", "", "1234567"])
def test_register_rejects_short_password(client, open_registration, invite_code, password):
    err(register(client, "shorty", password=password, code=invite_code), "validation_error", 400)


def test_register_response_hides_secrets(client, open_registration, invite_code):
    payload = ok(register(client, "opaque", code=invite_code), 201)
    assert set(payload["user"]) == USER_KEYS


# ── 登录 ─────────────────────────────────────────────────

def test_login_success(client, user):
    payload = ok(client.post("/api/auth/login", json={"username": "alice", "password": PASSWORD}))
    assert set(payload["user"]) == USER_KEYS
    assert payload["user"]["username"] == "alice"

    fresh = ApiClient(client, payload["token"], "alice")
    assert ok(fresh.get("/api/auth/me"))["user"]["username"] == "alice"


def test_login_is_case_insensitive_on_username(client, user):
    payload = ok(client.post("/api/auth/login", json={"username": "ALICE", "password": PASSWORD}))
    assert payload["user"]["username"] == "alice"  # 展示用的原始大小写


def test_login_hides_whether_user_exists(client, user):
    """错误密码与不存在的用户必须给出完全一致的响应，否则可用来枚举用户名。"""
    wrong_password = client.post("/api/auth/login", json={"username": "alice", "password": "nope12345"})
    no_such_user = client.post("/api/auth/login", json={"username": "ghost", "password": "nope12345"})

    assert wrong_password.status_code == no_such_user.status_code == 401
    assert wrong_password.get_json() == no_such_user.get_json()
    err(wrong_password, "unauthorized", 401)


def test_login_rate_limited_after_five_failures(client, user):
    for _ in range(5):
        err(client.post("/api/auth/login", json={"username": "alice", "password": "wrong1234"}),
            "unauthorized", 401)
    err(client.post("/api/auth/login", json={"username": "alice", "password": "wrong1234"}),
        "rate_limited", 429)
    # 正确密码同样被挡住 —— 限流按用户名计，不看密码对错
    err(client.post("/api/auth/login", json={"username": "alice", "password": PASSWORD}),
        "rate_limited", 429)


def test_login_rate_limit_is_per_username(client, user, other_user):
    for _ in range(5):
        client.post("/api/auth/login", json={"username": "alice", "password": "wrong1234"})
    ok(client.post("/api/auth/login", json={"username": "bob", "password": PASSWORD}))


def test_successful_login_clears_failure_counter(client, user):
    for _ in range(4):
        client.post("/api/auth/login", json={"username": "alice", "password": "wrong1234"})
    ok(client.post("/api/auth/login", json={"username": "alice", "password": PASSWORD}))
    for _ in range(5):
        err(client.post("/api/auth/login", json={"username": "alice", "password": "wrong1234"}),
            "unauthorized", 401)


def test_disabled_account_cannot_login(app, client, user):
    disable(app, "alice")
    err(client.post("/api/auth/login", json={"username": "alice", "password": PASSWORD}),
        "forbidden", 403)


def test_disabled_account_token_stops_working(app, user):
    disable(app, "alice")
    err(user.get("/api/auth/me"), "forbidden", 403)


# ── /me ──────────────────────────────────────────────────

def test_me_requires_token(anon):
    err(anon.get("/api/auth/me"), "unauthorized", 401)


@pytest.mark.parametrize("header", ["", "Bearer", "Bearer ", "Bearer garbage", "Token abc", "Basic YWJj"])
def test_me_rejects_malformed_authorization(client, header):
    err(client.get("/api/auth/me", headers={"Authorization": header}), "unauthorized", 401)


def test_me_rejects_tampered_token(client, user):
    tampered = user.token[:-4] + ("aaaa" if not user.token.endswith("aaaa") else "bbbb")
    err(client.get("/api/auth/me", headers={"Authorization": f"Bearer {tampered}"}),
        "unauthorized", 401)


def test_me_rejects_token_of_deleted_user(app, client, user):
    from app import storage

    with app.app_context():
        storage.delete_user("alice")
    err(user.get("/api/auth/me"), "unauthorized", 401)


def test_me_exposes_only_public_fields(user):
    assert set(ok(user.get("/api/auth/me"))["user"]) == USER_KEYS


# ── 改密码 ────────────────────────────────────────────────

def test_change_password_rotates_tokens(client, user):
    payload = ok(user.post("/api/auth/password",
                           json={"old_password": PASSWORD, "new_password": "brand-new-pw"}))
    new_token = payload["token"]
    assert set(payload) == {"token"}
    assert new_token != user.token

    err(user.get("/api/auth/me"), "unauthorized", 401)  # 旧 token 立刻作废
    rotated = ApiClient(client, new_token, "alice")
    assert ok(rotated.get("/api/auth/me"))["user"]["username"] == "alice"

    ok(client.post("/api/auth/login", json={"username": "alice", "password": "brand-new-pw"}))
    err(client.post("/api/auth/login", json={"username": "alice", "password": PASSWORD}),
        "unauthorized", 401)


def test_change_password_rejects_wrong_old_password(user):
    err(user.post("/api/auth/password",
                  json={"old_password": "not-the-one", "new_password": "brand-new-pw"}),
        "unauthorized", 401)
    ok(user.get("/api/auth/me"))  # 失败不该动 token_version


@pytest.mark.parametrize("new_password", ["short", "", None, 12345678])
def test_change_password_rejects_bad_new_password(user, new_password):
    err(user.post("/api/auth/password",
                  json={"old_password": PASSWORD, "new_password": new_password}),
        "validation_error", 400)


def test_change_password_requires_auth(anon):
    err(anon.post("/api/auth/password",
                  json={"old_password": PASSWORD, "new_password": "brand-new-pw"}),
        "unauthorized", 401)


# ── 请求体健壮性 ──────────────────────────────────────────

def test_endpoints_tolerate_missing_body(client, anon, open_registration):
    err(client.post("/api/auth/register"), "invalid_invite", 400)
    err(client.post("/api/auth/login"), "unauthorized", 401)


def test_non_object_body_is_rejected(client, open_registration):
    err(client.post("/api/auth/register", json=["not", "an", "object"]), "validation_error", 400)
