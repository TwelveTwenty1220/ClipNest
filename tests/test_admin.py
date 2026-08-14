"""管理员 API 测试 —— 见 docs/API.md 第 6 节。

注意：这里不走 /api/auth/register 建普通用户（认证模块可能尚未实现），
一律用 storage.create_user + security.issue_token 直接造账号与 token。
"""

import pytest

from tests.conftest import ApiClient, err, ok

ADMIN_USER_FIELDS = {"username", "role", "created_at", "disabled", "item_count", "folder_count"}

# 所有管理接口，用于批量验证权限（方法, 路径）
ADMIN_ENDPOINTS = [
    ("get", "/api/admin/invite", None),
    ("get", "/api/admin/settings", None),
    ("patch", "/api/admin/settings", {"registration_open": True}),
    ("get", "/api/admin/users", None),
    ("patch", "/api/admin/users/1220", {"disabled": True}),
    ("post", "/api/admin/users/1220/reset_password", None),
    ("delete", "/api/admin/users/1220", None),
]


def _call(api: ApiClient, method: str, path: str, payload):
    fn = getattr(api, method)
    return fn(path) if payload is None and method == "get" else fn(path, json=payload)


@pytest.fixture()
def make_account(app, client):
    """直接建账号并签发 token，绕开尚未实现的注册接口。"""
    from app import security, storage

    def _make(username: str, password: str = "password123", role: str = "user"):
        with app.app_context():
            salt, digest = security.hash_password(password)
            record = storage.create_user(username, salt, digest, role=role)
            token = security.issue_token(record)
        return ApiClient(client, token, username)

    return _make


@pytest.fixture()
def normal(make_account):
    return make_account("alice")


def _seed_store(app, username: str, folders: int, items: int):
    """给指定用户播种若干文件夹与条目，用于验证计数。"""
    from app import storage, tree

    with app.app_context():
        uid = storage.get_user(username)["uid"]
        with storage.mutate_store(uid) as store:
            for index in range(folders):
                tree.make_folder(store, f"文件夹{index}", None)
            for index in range(items):
                tree.make_item(store, f"条目{index}", "内容", None)


# ── 邀请码 ───────────────────────────────────────────────

def test_invite_matches_current_code(app, admin):
    from app import invite

    data = ok(admin.get("/api/admin/invite"))
    assert set(data) == {"code", "expires_in", "period"}
    assert len(data["code"]) == invite.INVITE_LEN
    assert set(data["code"]) <= set(invite.INVITE_ALPHABET)
    assert data["period"] == invite.INVITE_PERIOD
    assert 0 < data["expires_in"] <= invite.INVITE_PERIOD
    with app.app_context():
        assert data["code"] == invite.current_code()


# ── 注册开关 ─────────────────────────────────────────────

def test_settings_default_closed(admin):
    assert ok(admin.get("/api/admin/settings")) == {"registration_open": False}


def test_settings_patch_roundtrip(admin, app):
    from app import storage

    assert ok(admin.patch("/api/admin/settings", json={"registration_open": True})) == {"registration_open": True}
    assert ok(admin.get("/api/admin/settings"))["registration_open"] is True
    with app.app_context():
        assert storage.load_app_config()["registration_open"] is True

    assert ok(admin.patch("/api/admin/settings", json={"registration_open": False})) == {"registration_open": False}
    assert ok(admin.get("/api/admin/settings"))["registration_open"] is False


def test_settings_patch_requires_field(admin):
    err(admin.patch("/api/admin/settings", json={}), "validation_error", 400)


@pytest.mark.parametrize("value", ["true", 1, None, [], {}])
def test_settings_patch_rejects_non_bool(admin, value):
    err(admin.patch("/api/admin/settings", json={"registration_open": value}), "validation_error", 400)


# ── 用户列表 ─────────────────────────────────────────────

def test_users_lists_admin_only_at_first(admin):
    users = ok(admin.get("/api/admin/users"))["users"]
    assert [u["username"] for u in users] == ["1220"]
    assert users[0]["role"] == "admin"
    assert users[0]["disabled"] is False
    assert users[0]["item_count"] == 0
    assert users[0]["folder_count"] == 0


def test_users_includes_new_user_with_counts(admin, app, normal):
    _seed_store(app, "alice", folders=2, items=3)

    users = {u["username"]: u for u in ok(admin.get("/api/admin/users"))["users"]}
    assert set(users) == {"1220", "alice"}
    assert users["alice"]["role"] == "user"
    assert users["alice"]["folder_count"] == 2
    assert users["alice"]["item_count"] == 3
    # 别人的数据不该串进来
    assert users["1220"]["item_count"] == 0


def test_users_never_leak_secrets(admin, normal):
    for view in ok(admin.get("/api/admin/users"))["users"]:
        assert set(view) == ADMIN_USER_FIELDS


# ── 禁用 / 解禁 ──────────────────────────────────────────

def test_disable_kills_token_immediately(admin, make_account):
    # 用第二个管理员来观察 token 状态：禁用后 403，解禁后因 tv 自增变 401
    victim = make_account("carol", role="admin")
    ok(victim.get("/api/admin/settings"))

    data = ok(admin.patch("/api/admin/users/carol", json={"disabled": True}))
    assert data["user"]["disabled"] is True
    assert set(data["user"]) == ADMIN_USER_FIELDS

    err(victim.get("/api/admin/settings"), "forbidden", 403)


def test_enable_also_invalidates_old_token(admin, app, make_account):
    from app import security, storage

    victim = make_account("carol", role="admin")
    old_token = victim.token
    ok(admin.patch("/api/admin/users/carol", json={"disabled": True}))
    assert ok(admin.patch("/api/admin/users/carol", json={"disabled": False}))["user"]["disabled"] is False

    victim.token = old_token
    err(victim.get("/api/admin/settings"), "unauthorized", 401)

    # 重新登录（签发新 token）后恢复可用
    with app.app_context():
        victim.token = security.issue_token(storage.get_user("carol"))
    ok(victim.get("/api/admin/settings"))


def test_disable_bumps_token_version(admin, app, normal):
    from app import storage

    with app.app_context():
        before = storage.get_user("alice")["token_version"]
    ok(admin.patch("/api/admin/users/alice", json={"disabled": True}))
    with app.app_context():
        assert storage.get_user("alice")["token_version"] == before + 1
        assert storage.get_user("alice")["disabled"] is True


def test_cannot_disable_self(admin, app):
    from app import storage

    err(admin.patch("/api/admin/users/1220", json={"disabled": True}), "forbidden", 403)
    with app.app_context():
        assert storage.get_user("1220")["disabled"] is False


def test_cannot_disable_self_case_insensitive(app, client, make_account):
    """管理员名字换个大小写也还是自己。"""
    from app import security, storage

    with app.app_context():
        salt, digest = security.hash_password("password123")
        record = storage.create_user("BossMan", salt, digest, role="admin")
        boss = ApiClient(client, security.issue_token(record), "BossMan")
    err(boss.patch("/api/admin/users/bossman", json={"disabled": True}), "forbidden", 403)


def test_disable_requires_bool_field(admin, normal):
    err(admin.patch("/api/admin/users/alice", json={}), "validation_error", 400)
    err(admin.patch("/api/admin/users/alice", json={"disabled": "yes"}), "validation_error", 400)


# ── 重置密码 ─────────────────────────────────────────────

def test_reset_password_returns_working_password(admin, app, make_account):
    from app import security, storage

    victim = make_account("carol", role="admin")
    data = ok(admin.post("/api/admin/users/carol/reset_password"))
    assert set(data) == {"password"}
    password = data["password"]
    assert len(password) == 16

    # 旧 token 立刻失效
    err(victim.get("/api/admin/settings"), "unauthorized", 401)

    with app.app_context():
        record = storage.get_user("carol")
        assert security.verify_password(password, record["pwd_salt"], record["pwd_hash"])
        assert not security.verify_password("password123", record["pwd_salt"], record["pwd_hash"])
        # 用新签发的 token 能正常访问
        victim.token = security.issue_token(record)
    ok(victim.get("/api/admin/settings"))


def test_reset_password_is_random(admin, normal):
    first = ok(admin.post("/api/admin/users/alice/reset_password"))["password"]
    second = ok(admin.post("/api/admin/users/alice/reset_password"))["password"]
    assert first != second


def test_admin_can_reset_own_password(admin, app):
    """重置自己是允许的（只有禁用与删除才禁止）。"""
    from app import security, storage

    password = ok(admin.post("/api/admin/users/1220/reset_password"))["password"]
    with app.app_context():
        record = storage.get_user("1220")
    assert security.verify_password(password, record["pwd_salt"], record["pwd_hash"])


# ── 删除用户 ─────────────────────────────────────────────

def _seed_cross_user_traces(app, victim: str, bystander: str):
    """给被删用户造点散落各处的痕迹：公开链接 + 他人的收发件箱记录。"""
    from app import storage

    with app.app_context():
        victim_uid = storage.get_user(victim)["uid"]
        other_uid = storage.get_user(bystander)["uid"]

        storage.save_link("aaaaaaaaaaaaaaaa", {"token": "aaaaaaaaaaaaaaaa", "owner_uid": victim_uid,
                                               "kind": "item", "summary": "x", "payload": {},
                                               "created_at": 1, "expires_at": None})
        storage.save_link("bbbbbbbbbbbbbbbb", {"token": "bbbbbbbbbbbbbbbb", "owner_uid": other_uid,
                                               "kind": "item", "summary": "y", "payload": {},
                                               "created_at": 1, "expires_at": None})

        with storage.mutate_inbox(other_uid) as inbox:
            inbox["shares"] = [
                {"id": "s_1", "from": victim, "from_uid": victim_uid, "payload": {}, "created_at": 1,
                 "accepted_at": None},
                {"id": "s_2", "from": "ghost", "from_uid": "deadbeef" * 4, "payload": {}, "created_at": 2,
                 "accepted_at": None},
            ]
        with storage.mutate_outbox(other_uid) as outbox:
            outbox["shares"] = [
                {"id": "s_3", "to": victim, "to_uid": victim_uid, "kind": "item", "summary": "a",
                 "created_at": 1, "accepted": False},
                {"id": "s_4", "to": "ghost", "to_uid": "deadbeef" * 4, "kind": "item", "summary": "b",
                 "created_at": 2, "accepted": False},
            ]
        return victim_uid, other_uid


def test_delete_user_removes_record_and_data(admin, app, make_account):
    from app import storage

    make_account("alice")
    make_account("bob")
    _seed_store(app, "alice", folders=1, items=1)
    victim_uid, other_uid = _seed_cross_user_traces(app, "alice", "bob")

    response = admin.delete("/api/admin/users/alice")
    assert response.status_code == 204, response.get_data(as_text=True)
    assert response.get_data() == b""

    with app.app_context():
        assert storage.get_user("alice") is None
        assert not storage.user_dir(victim_uid).exists()
        # 他发出的公开链接被清，别人的留着
        assert storage.list_links(victim_uid) == []
        assert len(storage.list_links(other_uid)) == 1
        # 别人收件箱里来自他的分享被清
        assert [s["id"] for s in storage.load_inbox(other_uid)["shares"]] == ["s_2"]
        # 别人 outbox 里发给他的记录被清
        assert [s["id"] for s in storage.load_outbox(other_uid)["shares"]] == ["s_4"]

    assert [u["username"] for u in ok(admin.get("/api/admin/users"))["users"]] == ["1220", "bob"]


def test_delete_user_leaves_untouched_users_alone(admin, app, make_account):
    """没有牵连的用户不应被写盘 —— 收发件箱内容原样保留。"""
    from app import storage

    make_account("alice")
    make_account("bob")
    with app.app_context():
        bob_uid = storage.get_user("bob")["uid"]
        with storage.mutate_inbox(bob_uid) as inbox:
            inbox["shares"] = [{"id": "s_9", "from": "ghost", "from_uid": "cafe" * 8, "payload": {},
                                "created_at": 1, "accepted_at": None}]

    ok(admin.delete("/api/admin/users/alice"), 204)
    with app.app_context():
        assert [s["id"] for s in storage.load_inbox(bob_uid)["shares"]] == ["s_9"]


def test_cannot_delete_self(admin, app):
    from app import storage

    err(admin.delete("/api/admin/users/1220"), "forbidden", 403)
    with app.app_context():
        assert storage.get_user("1220") is not None


# ── 不存在的用户 ─────────────────────────────────────────

def test_unknown_user_is_404(admin):
    err(admin.patch("/api/admin/users/nobody", json={"disabled": True}), "not_found", 404)
    err(admin.post("/api/admin/users/nobody/reset_password"), "not_found", 404)
    err(admin.delete("/api/admin/users/nobody"), "not_found", 404)


# ── 权限 ─────────────────────────────────────────────────

@pytest.mark.parametrize("method,path,payload", ADMIN_ENDPOINTS)
def test_normal_user_is_forbidden(normal, method, path, payload):
    err(_call(normal, method, path, payload), "forbidden", 403)


@pytest.mark.parametrize("method,path,payload", ADMIN_ENDPOINTS)
def test_anonymous_is_unauthorized(anon, method, path, payload):
    err(_call(anon, method, path, payload), "unauthorized", 401)


@pytest.mark.parametrize("method,path,payload", ADMIN_ENDPOINTS)
def test_garbage_token_is_unauthorized(client, method, path, payload):
    err(_call(ApiClient(client, "not-a-jwt"), method, path, payload), "unauthorized", 401)


def test_forbidden_user_cannot_change_settings(normal, admin, app):
    from app import storage

    err(normal.patch("/api/admin/settings", json={"registration_open": True}), "forbidden", 403)
    with app.app_context():
        assert storage.load_app_config()["registration_open"] is False
