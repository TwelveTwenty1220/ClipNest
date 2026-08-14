"""分享 API 测试 —— 见 docs/API.md 第 5 节。

auth / store 两个模块可能还没实现，所以这里不通过 HTTP 建号或建条目：
账号直接落库 + 签发 token，数据直接往 store.json 里播种。
"""

from contextlib import contextmanager

import pytest

from app import security, storage, tree, validators
from tests.conftest import ApiClient, err, ok


# ── 夹具与播种辅助 ────────────────────────────────────────

@pytest.fixture()
def account(app, client):
    """建号并签发 token。密码哈希填固定假值 —— 这些账号只用 token 认证，从不走登录。"""

    def _make(username: str) -> ApiClient:
        with app.app_context():
            record = storage.create_user(username, "00" * 16, "11" * 32)
            return ApiClient(client, security.issue_token(record), record["username"])

    return _make


@pytest.fixture()
def alice(account):
    return account("alice")


@pytest.fixture()
def bob(account):
    return account("bob")


def uid_of(app, username: str) -> str:
    with app.app_context():
        return storage.get_user(username)["uid"]


@contextmanager
def user_store(app, username: str):
    """直接改某个用户的 store.json。"""
    with app.app_context():
        with storage.mutate_store(storage.get_user(username)["uid"]) as store:
            yield store


def load_store_of(app, username: str) -> dict:
    with app.app_context():
        return storage.load_store(storage.get_user(username)["uid"])


def seed_item(app, username, title="默认配置", content="PORT=8420", folder_id=None) -> str:
    with user_store(app, username) as store:
        return tree.make_item(store, title, content, folder_id)["id"]


def seed_tree(app, username) -> dict:
    """配置 ├ 默认配置  └ 老版本 ├ 旧配置。返回各节点 id。"""
    with user_store(app, username) as store:
        root = tree.make_folder(store, "配置", None)
        legacy = tree.make_folder(store, "老版本", root["id"])
        tree.make_item(store, "默认配置", "PORT=8420", root["id"])
        tree.make_item(store, "旧配置", "PORT=9000", legacy["id"])
        return {"root": root["id"], "legacy": legacy["id"]}


def share_item(alice, bob, iid) -> str:
    """A 把条目分享给 B，返回 share id。"""
    body = ok(alice.post("/api/share/direct", json={"to": bob.username, "kind": "item", "id": iid}), 201)
    return body["share"]["id"]


# ── 定向分享：条目 ────────────────────────────────────────

def test_share_item_reaches_inbox_and_outbox(app, alice, bob):
    iid = seed_item(app, "alice")
    sid = share_item(alice, bob, iid)

    inbox = ok(bob.get("/api/share/inbox"))["shares"]
    assert len(inbox) == 1
    received = inbox[0]
    assert received["id"] == sid
    assert received["from"] == "alice"
    assert received["accepted_at"] is None
    assert received["payload"] == {"kind": "item", "item": {"title": "默认配置", "content": "PORT=8420"}}

    outbox = ok(alice.get("/api/share/outbox"))["shares"]
    assert len(outbox) == 1
    assert outbox[0] == {
        "id": sid,
        "to": "bob",
        "kind": "item",
        "summary": "默认配置",
        "created_at": received["created_at"],
        "accepted": False,
    }


def test_inbox_never_leaks_internal_fields(app, alice, bob):
    share_item(alice, bob, seed_item(app, "alice"))
    received = ok(bob.get("/api/share/inbox"))["shares"][0]
    assert set(received) == {"id", "from", "payload", "created_at", "accepted_at"}


def test_snapshot_is_frozen_at_send_time(app, alice, bob):
    """快照语义：发出之后再改原条目，收件箱里仍是旧内容。"""
    iid = seed_item(app, "alice", content="旧内容")
    share_item(alice, bob, iid)

    with user_store(app, "alice") as store:
        tree.find_item(store, iid)["content"] = "新内容"

    received = ok(bob.get("/api/share/inbox"))["shares"][0]
    assert received["payload"]["item"]["content"] == "旧内容"


# ── 定向分享：文件夹 ──────────────────────────────────────

def test_share_folder_carries_whole_subtree(app, alice, bob):
    ids = seed_tree(app, "alice")
    ok(alice.post("/api/share/direct", json={"to": "bob", "kind": "folder", "id": ids["root"]}), 201)

    payload = ok(bob.get("/api/share/inbox"))["shares"][0]["payload"]
    assert payload["kind"] == "folder"
    assert payload["name"] == "配置"
    assert [f["name"] for f in payload["folders"]] == ["老版本"]
    assert payload["folders"][0]["parent_id"] is None  # 根的直接子文件夹挂空
    assert sorted(i["title"] for i in payload["items"]) == ["旧配置", "默认配置"]


def test_accept_folder_rebuilds_subtree_with_new_ids(app, alice, bob):
    ids = seed_tree(app, "alice")
    ok(alice.post("/api/share/direct", json={"to": "bob", "kind": "folder", "id": ids["root"]}), 201)
    sid = ok(bob.get("/api/share/inbox"))["shares"][0]["id"]

    result = ok(bob.post(f"/api/share/inbox/{sid}/accept", json={"folder_id": None}))
    assert (result["created_folders"], result["created_items"]) == (2, 2)

    store = load_store_of(app, "bob")
    by_name = {f["name"]: f for f in store["folders"]}
    assert set(by_name) == {"配置", "老版本"}
    assert by_name["配置"]["parent_id"] is None
    assert by_name["老版本"]["parent_id"] == by_name["配置"]["id"]

    items = {i["title"]: i for i in store["items"]}
    assert items["默认配置"]["folder_id"] == by_name["配置"]["id"]
    assert items["旧配置"]["folder_id"] == by_name["老版本"]["id"]

    # id 全部重新生成，与 A 那边毫无重叠
    alice_ids = {f["id"] for f in load_store_of(app, "alice")["folders"]}
    assert alice_ids.isdisjoint({f["id"] for f in store["folders"]})


# ── 接受 ─────────────────────────────────────────────────

def test_accept_into_named_folder(app, alice, bob):
    sid = share_item(alice, bob, seed_item(app, "alice"))
    with user_store(app, "bob") as store:
        target = tree.make_folder(store, "收藏", None)["id"]

    result = ok(bob.post(f"/api/share/inbox/{sid}/accept", json={"folder_id": target}))
    assert result["created_items"] == 1 and result["created_folders"] == 0

    store = load_store_of(app, "bob")
    assert result["rev"] == store["rev"]
    assert [i["folder_id"] for i in store["items"]] == [target]


def test_accept_to_root_when_folder_id_is_null(app, alice, bob):
    sid = share_item(alice, bob, seed_item(app, "alice"))
    ok(bob.post(f"/api/share/inbox/{sid}/accept", json={"folder_id": None}))
    assert [i["folder_id"] for i in load_store_of(app, "bob")["items"]] == [None]


def test_accept_into_missing_folder_is_404(app, alice, bob):
    sid = share_item(alice, bob, seed_item(app, "alice"))
    err(bob.post(f"/api/share/inbox/{sid}/accept", json={"folder_id": "f_deadbeef0000"}), "not_found", 404)
    assert load_store_of(app, "bob")["items"] == []


def test_accept_marks_both_sides_but_keeps_the_share(app, alice, bob):
    sid = share_item(alice, bob, seed_item(app, "alice"))
    ok(bob.post(f"/api/share/inbox/{sid}/accept", json={"folder_id": None}))

    inbox = ok(bob.get("/api/share/inbox"))["shares"]
    assert len(inbox) == 1, "落地后分享仍留在收件箱，由用户自行删除"
    assert inbox[0]["accepted_at"] is not None

    assert ok(alice.get("/api/share/outbox"))["shares"][0]["accepted"] is True


def test_accept_twice_stores_a_second_copy(app, alice, bob):
    """重复接受是合法的"再存一份"，不做幂等。"""
    sid = share_item(alice, bob, seed_item(app, "alice"))
    first = ok(bob.post(f"/api/share/inbox/{sid}/accept", json={"folder_id": None}))
    second = ok(bob.post(f"/api/share/inbox/{sid}/accept", json={"folder_id": None}))

    assert second["rev"] > first["rev"]
    assert len(load_store_of(app, "bob")["items"]) == 2


def test_accept_survives_deleted_sender(app, alice, bob):
    sid = share_item(alice, bob, seed_item(app, "alice"))
    with app.app_context():
        storage.delete_user("alice")
    ok(bob.post(f"/api/share/inbox/{sid}/accept", json={"folder_id": None}))
    assert len(load_store_of(app, "bob")["items"]) == 1


# ── 忽略与撤回 ────────────────────────────────────────────

def test_delete_inbox_share(app, alice, bob):
    sid = share_item(alice, bob, seed_item(app, "alice"))
    assert ok(bob.delete(f"/api/share/inbox/{sid}")) == {"ok": True}
    assert ok(bob.get("/api/share/inbox"))["shares"] == []
    err(bob.delete(f"/api/share/inbox/{sid}"), "not_found", 404)


def test_revoke_removes_it_from_receiver_inbox(app, alice, bob):
    sid = share_item(alice, bob, seed_item(app, "alice"))
    assert ok(alice.delete(f"/api/share/outbox/{sid}")) == {"ok": True}
    assert ok(bob.get("/api/share/inbox"))["shares"] == []
    assert ok(alice.get("/api/share/outbox"))["shares"] == []


def test_revoke_after_accept_conflicts(app, alice, bob):
    sid = share_item(alice, bob, seed_item(app, "alice"))
    ok(bob.post(f"/api/share/inbox/{sid}/accept", json={"folder_id": None}))

    err(alice.delete(f"/api/share/outbox/{sid}"), "conflict", 409)
    assert len(ok(bob.get("/api/share/inbox"))["shares"]) == 1
    assert len(ok(alice.get("/api/share/outbox"))["shares"]) == 1


def test_revoke_unknown_share_is_404(alice):
    err(alice.delete("/api/share/outbox/s_deadbeef0000"), "not_found", 404)


# ── 校验与越权 ────────────────────────────────────────────

def test_share_to_unknown_user_is_404(app, alice):
    err(
        alice.post("/api/share/direct", json={"to": "nobody", "kind": "item", "id": seed_item(app, "alice")}),
        "not_found",
        404,
    )


def test_share_to_self_is_validation_error(app, alice):
    iid = seed_item(app, "alice")
    err(alice.post("/api/share/direct", json={"to": "alice", "kind": "item", "id": iid}), "validation_error", 400)
    # 大小写不敏感，ALICE 同样是自己
    err(alice.post("/api/share/direct", json={"to": "ALICE", "kind": "item", "id": iid}), "validation_error", 400)


def test_share_missing_resource_is_404(app, alice, bob):
    ids = seed_tree(app, "alice")
    err(alice.post("/api/share/direct", json={"to": "bob", "kind": "item", "id": "i_deadbeef0000"}), "not_found", 404)
    err(alice.post("/api/share/direct", json={"to": "bob", "kind": "folder", "id": "f_deadbeef0000"}), "not_found", 404)
    # kind 与 id 类型对不上也是 404
    err(alice.post("/api/share/direct", json={"to": "bob", "kind": "item", "id": ids["root"]}), "not_found", 404)


def test_share_others_resource_is_404(app, alice, bob):
    """B 拿着 A 的条目 id 分享给自己人 —— 只在自己的 store 里找，找不到。"""
    iid = seed_item(app, "alice")
    err(bob.post("/api/share/direct", json={"to": "alice", "kind": "item", "id": iid}), "not_found", 404)


def test_bad_kind_is_validation_error(app, alice):
    iid = seed_item(app, "alice")
    err(alice.post("/api/share/direct", json={"to": "bob", "kind": "tree", "id": iid}), "validation_error", 400)


def test_cannot_touch_someone_elses_inbox_share(app, account, alice, bob):
    """C 发给 A 的分享，B 既不能接受也不能删除。"""
    carol = account("carol")
    sid = share_item(carol, alice, seed_item(app, "carol"))

    err(bob.post(f"/api/share/inbox/{sid}/accept", json={"folder_id": None}), "not_found", 404)
    err(bob.delete(f"/api/share/inbox/{sid}"), "not_found", 404)
    assert len(ok(alice.get("/api/share/inbox"))["shares"]) == 1


def test_cannot_revoke_someone_elses_outbox_share(app, account, alice, bob):
    carol = account("carol")
    sid = share_item(carol, alice, seed_item(app, "carol"))
    err(bob.delete(f"/api/share/outbox/{sid}"), "not_found", 404)
    assert len(ok(alice.get("/api/share/inbox"))["shares"]) == 1


def test_full_inbox_rejects_new_share(app, alice, bob):
    with app.app_context():
        with storage.mutate_inbox(uid_of(app, "bob")) as inbox:
            inbox["shares"] = [{"id": f"s_{n:012x}", "created_at": n} for n in range(validators.MAX_INBOX)]

    iid = seed_item(app, "alice")
    err(alice.post("/api/share/direct", json={"to": "bob", "kind": "item", "id": iid}), "quota_exceeded", 409)
    assert ok(alice.get("/api/share/outbox"))["shares"] == [], "对方满了就不该在发件箱留孤儿记录"


# ── 公开链接 ─────────────────────────────────────────────

def test_public_link_roundtrip(app, alice, anon):
    iid = seed_item(app, "alice")
    link = ok(alice.post("/api/share/link", json={"kind": "item", "id": iid}), 201)["link"]
    assert set(link) == {"token", "url", "kind", "summary", "created_at", "expires_at"}
    assert link["url"] == f"/s/{link['token']}"
    assert link["summary"] == "默认配置" and link["expires_at"] is None

    body = ok(anon.get(f"/api/public/{link['token']}"))
    assert body["payload"]["item"]["content"] == "PORT=8420"
    assert body["expires_at"] is None

    assert [l["token"] for l in ok(alice.get("/api/share/links"))["links"]] == [link["token"]]

    assert ok(alice.delete(f"/api/share/links/{link['token']}")) == {"ok": True}
    err(anon.get(f"/api/public/{link['token']}"), "not_found", 404)
    assert ok(alice.get("/api/share/links"))["links"] == []


def test_public_link_of_folder_snapshot(app, alice, anon):
    ids = seed_tree(app, "alice")
    link = ok(alice.post("/api/share/link", json={"kind": "folder", "id": ids["root"]}), 201)["link"]
    payload = ok(anon.get(f"/api/public/{link['token']}"))["payload"]
    assert payload["kind"] == "folder" and payload["name"] == "配置"
    assert len(payload["items"]) == 2


def test_public_link_expiry(app, alice, anon):
    iid = seed_item(app, "alice")
    link = ok(alice.post("/api/share/link", json={"kind": "item", "id": iid, "expires_in": 60}), 201)["link"]
    assert link["expires_at"] > link["created_at"]
    ok(anon.get(f"/api/public/{link['token']}"))

    with app.app_context():
        data = storage.load_link(link["token"])
        data["expires_at"] = storage.now() - 1
        storage.save_link(link["token"], data)

        err(anon.get(f"/api/public/{link['token']}"), "not_found", 404)
        assert storage.load_link(link["token"]) is None, "过期链接应被惰性清理掉"


def test_link_expires_in_must_be_positive_int(app, alice):
    iid = seed_item(app, "alice")
    err(alice.post("/api/share/link", json={"kind": "item", "id": iid, "expires_in": 0}), "validation_error", 400)
    err(alice.post("/api/share/link", json={"kind": "item", "id": iid, "expires_in": "600"}), "validation_error", 400)


def test_link_to_missing_resource_is_404(alice):
    err(alice.post("/api/share/link", json={"kind": "item", "id": "i_deadbeef0000"}), "not_found", 404)


def test_links_are_scoped_to_owner(app, alice, bob):
    link = ok(alice.post("/api/share/link", json={"kind": "item", "id": seed_item(app, "alice")}), 201)["link"]
    assert ok(bob.get("/api/share/links"))["links"] == []
    err(bob.delete(f"/api/share/links/{link['token']}"), "not_found", 404)
    # 仍然活着
    assert len(ok(alice.get("/api/share/links"))["links"]) == 1


def test_link_quota(app, alice):
    with app.app_context():
        uid = uid_of(app, "alice")
        for n in range(validators.MAX_LINKS):
            token = f"seeded{n:058d}"
            storage.save_link(token, {"token": token, "owner_uid": uid, "created_at": n})

    err(
        alice.post("/api/share/link", json={"kind": "item", "id": seed_item(app, "alice")}),
        "quota_exceeded",
        409,
    )


@pytest.mark.parametrize(
    "token",
    ["short", "..%2F..%2Fconfig", "." * 24, "aaaaaaaaaaaaaaaaaaaaaaaa"],
)
def test_bad_or_unknown_token_is_404_not_500(anon, alice, token):
    """非法 token（过短、含 ../、非法字符）不能炸成 500。"""
    assert anon.get(f"/api/public/{token}").status_code == 404
    assert alice.delete(f"/api/share/links/{token}").status_code == 404


# ── 认证 ─────────────────────────────────────────────────

@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", "/api/share/direct"),
        ("get", "/api/share/inbox"),
        ("post", "/api/share/inbox/s_1/accept"),
        ("delete", "/api/share/inbox/s_1"),
        ("get", "/api/share/outbox"),
        ("delete", "/api/share/outbox/s_1"),
        ("post", "/api/share/link"),
        ("get", "/api/share/links"),
        ("delete", "/api/share/links/aaaaaaaaaaaaaaaaaaaa"),
    ],
)
def test_share_endpoints_require_auth(anon, method, path):
    err(getattr(anon, method)(path), "unauthorized", 401)


def test_public_endpoint_needs_no_auth(app, alice, anon):
    link = ok(alice.post("/api/share/link", json={"kind": "item", "id": seed_item(app, "alice")}), 201)["link"]
    assert anon.get(f"/api/public/{link['token']}").status_code == 200
