"""基础设施测试：存储、密码、JWT、邀请码、自举。"""

import json

import pytest

from tests.conftest import ok


def test_bootstrap_creates_secrets_and_admin(app, data_dir):
    from app import storage

    with app.app_context():
        cfg = storage.load_app_config()
        assert len(cfg["jwt_secret"]) == 64
        assert len(cfg["invite_secret"]) == 64
        assert cfg["jwt_secret"] != cfg["invite_secret"]
        assert cfg["registration_open"] is False

        admin = storage.get_user("1220")
        assert admin["role"] == "admin"
        assert admin["token_version"] == 1
        assert "pwd_hash" in admin

    password_file = data_dir / "ADMIN_PASSWORD.txt"
    assert password_file.exists()
    assert "1220" in password_file.read_text(encoding="utf-8")


def test_bootstrap_is_idempotent(app, data_dir):
    """再次 create_app 不应重新生成密钥或覆盖管理员。"""
    from app import create_app, storage

    with app.app_context():
        before = storage.load_app_config()["jwt_secret"]
        admin_before = storage.get_user("1220")["pwd_hash"]

    second = create_app(verbose_bootstrap=False)
    with second.app_context():
        assert storage.load_app_config()["jwt_secret"] == before
        assert storage.get_user("1220")["pwd_hash"] == admin_before


def test_public_user_hides_secrets(app):
    from app import storage

    with app.app_context():
        view = storage.public_user(storage.get_user("1220"))
    assert set(view) == {"username", "role", "created_at"}


# ── 存储 ─────────────────────────────────────────────────

def test_atomic_write_and_read(app, tmp_path):
    from app import storage

    target = tmp_path / "sub" / "x.json"
    storage.write_json_atomic(target, {"你好": "世界"})
    assert json.loads(target.read_text(encoding="utf-8")) == {"你好": "世界"}
    assert storage.read_json(target, {}) == {"你好": "世界"}
    # 临时文件不残留
    assert [p.name for p in target.parent.iterdir() if p.name.startswith(".tmp-")] == []


def test_read_json_recovers_from_corruption(app, tmp_path):
    from app import storage

    target = tmp_path / "broken.json"
    target.write_text("{ not json", encoding="utf-8")
    assert storage.read_json(target, {"fallback": True}) == {"fallback": True}
    # 损坏文件被留了一份现场
    assert any(p.name.startswith("broken.json.corrupt.") for p in tmp_path.iterdir())


def test_mutate_store_bumps_rev(app):
    from app import storage

    with app.app_context():
        uid = storage.get_user("1220")["uid"]
        assert storage.load_store(uid)["rev"] == 0
        with storage.mutate_store(uid) as store:
            store["items"].append({"id": "i_1"})
        assert storage.load_store(uid)["rev"] == 1


def test_mutate_store_nochange_does_not_bump(app):
    from app import storage

    with app.app_context():
        uid = storage.get_user("1220")["uid"]
        with storage.mutate_store(uid) as store:
            store["items"].append({"id": "i_ghost"})
            raise storage.NoChange
        reloaded = storage.load_store(uid)
        assert reloaded["rev"] == 0
        assert reloaded["items"] == []


def test_mutate_store_rolls_back_on_exception(app):
    from app import storage

    with app.app_context():
        uid = storage.get_user("1220")["uid"]
        with pytest.raises(RuntimeError):
            with storage.mutate_store(uid) as store:
                store["items"].append({"id": "i_ghost"})
                raise RuntimeError("boom")
        assert storage.load_store(uid) == {"rev": 0, "folders": [], "items": []}


def test_create_user_conflict(app):
    from app import security, storage
    from app.errors import ApiError

    with app.app_context():
        salt, digest = security.hash_password("password123")
        storage.create_user("Alice", salt, digest)
        # 大小写不敏感：alice 与 Alice 冲突
        with pytest.raises(ApiError) as excinfo:
            storage.create_user("alice", salt, digest)
        assert excinfo.value.code == "conflict"


def test_get_user_is_case_insensitive(app):
    from app import security, storage

    with app.app_context():
        salt, digest = security.hash_password("password123")
        storage.create_user("Alice", salt, digest)
        assert storage.get_user("ALICE")["username"] == "Alice"
        assert storage.get_user("alice")["uid"] == storage.get_user("Alice")["uid"]


def test_delete_user_removes_directory(app):
    from app import security, storage

    with app.app_context():
        salt, digest = security.hash_password("password123")
        record = storage.create_user("alice", salt, digest)
        directory = storage.user_dir(record["uid"])
        assert directory.exists()
        storage.delete_user("alice")
        assert not directory.exists()
        assert storage.get_user("alice") is None


def test_link_token_rejects_path_traversal(app):
    from app import storage
    from app.errors import ApiError

    with app.app_context():
        for bad in ("../../etc/passwd", "a", "", "tok/en", "x" * 100):
            with pytest.raises(ApiError) as excinfo:
                storage.link_path(bad)
            assert excinfo.value.code == "not_found"


def test_link_roundtrip(app):
    from app import storage

    with app.app_context():
        token = storage.new_link_token()
        storage.save_link(token, {"token": token, "owner_uid": "abc", "created_at": 1})
        assert storage.load_link(token)["owner_uid"] == "abc"
        assert [link["token"] for link in storage.list_links("abc")] == [token]
        assert storage.delete_link(token) is True
        assert storage.load_link(token) is None
        assert storage.delete_link(token) is False


def test_new_id_shape(app):
    from app import storage

    ident = storage.new_id("f")
    assert ident.startswith("f_") and len(ident) == 14
    assert storage.new_id("f") != storage.new_id("f")


# ── 密码与 JWT ───────────────────────────────────────────

def test_password_hash_roundtrip(app):
    from app import security

    salt, digest = security.hash_password("correct horse")
    assert security.verify_password("correct horse", salt, digest)
    assert not security.verify_password("wrong horse", salt, digest)
    # 同一密码两次哈希，盐不同结果也不同
    assert security.hash_password("correct horse")[1] != digest


def test_verify_password_tolerates_garbage(app):
    from app import security

    assert not security.verify_password("x", "zz", "zz")
    assert not security.verify_password("x", "", "")


def test_token_roundtrip(app):
    from app import security, storage

    with app.app_context():
        admin = storage.get_user("1220")
        payload = security.decode_token(security.issue_token(admin))
    assert payload["username"] == "1220"
    assert payload["role"] == "admin"
    assert payload["tv"] == 1
    assert payload["exp"] - payload["iat"] == 30 * 86400


def test_decode_token_rejects_tampering(app):
    from app import security, storage
    from app.errors import ApiError

    with app.app_context():
        token = security.issue_token(storage.get_user("1220"))
        with pytest.raises(ApiError) as excinfo:
            security.decode_token(token[:-3] + "aaa")
        assert excinfo.value.code == "unauthorized"


def test_random_password_avoids_confusing_chars(app):
    from app import security

    password = security.random_password(64)
    assert len(password) == 64
    assert not set(password) & set("0O1lI")


# ── 邀请码 ───────────────────────────────────────────────

def test_invite_code_shape_and_stability(app):
    from app import invite

    with app.app_context():
        code = invite.current_code()
        assert len(code) == invite.INVITE_LEN
        assert set(code) <= set(invite.INVITE_ALPHABET)
        assert invite.current_code() == code  # 同一窗口内稳定


def test_invite_code_verification(app):
    from app import invite

    with app.app_context():
        code = invite.current_code()
        assert invite.verify_code(code)
        assert invite.verify_code(code.lower())
        assert invite.verify_code(f" {code[:4]}-{code[4:]} ")
        assert not invite.verify_code("BADCODE1")
        assert not invite.verify_code("")
        assert not invite.verify_code(None)


def test_invite_accepts_previous_window(app, monkeypatch):
    from app import invite

    with app.app_context():
        previous = invite._code_for_window(invite._current_window() - 1)
        assert invite.verify_code(previous)
        # 再往前一个窗口就不认了
        older = invite._code_for_window(invite._current_window() - 2)
        assert not invite.verify_code(older)


def test_invite_expires_in_range(app):
    from app import invite

    with app.app_context():
        remaining = invite.code_expires_in()
        assert 0 < remaining <= invite.INVITE_PERIOD


# ── 错误处理与页面 ────────────────────────────────────────

def test_healthz(client):
    assert ok(client.get("/healthz")) == {"ok": True}


def test_unknown_route_returns_json_error(client):
    response = client.get("/api/definitely-not-here")
    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "not_found"


def test_security_headers(client):
    response = client.get("/healthz")
    assert response.headers["X-Content-Type-Options"] == "nosniff"
