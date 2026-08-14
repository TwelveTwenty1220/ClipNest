"""存储 API 测试 —— docs/API.md 第 4 节。

不走 /api/auth/register：认证模块可能尚未实现，这里照搬 conftest 的 admin
夹具思路，直接给 storage.create_user() 建出来的用户签发 token。
"""

import pytest

from tests.conftest import ApiClient, err, ok


@pytest.fixture()
def make_local_user(app, client):
    """建用户 + 直接签 token，绕开注册接口。密码哈希是占位值，测试里不登录。"""
    from app import security, storage

    def _make(username: str = "alice") -> ApiClient:
        with app.app_context():
            record = storage.create_user(username, "00" * 16, "11" * 32)
            token = security.issue_token(record)
        return ApiClient(client, token, username)

    return _make


@pytest.fixture()
def alice(make_local_user):
    return make_local_user("alice")


@pytest.fixture()
def bob(make_local_user):
    return make_local_user("bob")


# ── 小helper ─────────────────────────────────────────────

def mkfolder(u: ApiClient, name: str, parent_id=None) -> dict:
    return ok(u.post("/api/store/folders", json={"name": name, "parent_id": parent_id}), 201)["folder"]


def mkitem(u: ApiClient, content: str = "c", title=None, folder_id=None) -> dict:
    body = {"content": content, "folder_id": folder_id}
    if title is not None:
        body["title"] = title
    return ok(u.post("/api/store/items", json=body), 201)["item"]


def snapshot(u: ApiClient) -> dict:
    return ok(u.get("/api/store"))


def chain(u: ApiClient, depth: int, prefix: str = "d") -> list[dict]:
    """建一条 depth 层的链，返回自顶向下的文件夹列表。"""
    folders = []
    parent = None
    for level in range(depth):
        folder = mkfolder(u, f"{prefix}{level + 1}", parent)
        folders.append(folder)
        parent = folder["id"]
    return folders


# ── 增量拉取 ─────────────────────────────────────────────

def test_first_pull_is_full(alice):
    data = snapshot(alice)
    assert data["changed"] is True
    assert data["rev"] == 0
    assert data["folders"] == [] and data["items"] == []
    assert data["inbox_count"] == 0


def test_pull_with_current_rev_reports_unchanged(alice):
    rev = snapshot(alice)["rev"]
    data = ok(alice.get(f"/api/store?rev={rev}"))
    assert data == {"changed": False, "rev": rev}


def test_write_bumps_rev_and_pull_returns_full(alice):
    rev = snapshot(alice)["rev"]
    created = ok(alice.post("/api/store/folders", json={"name": "项目"}), 201)
    assert created["rev"] == rev + 1

    data = ok(alice.get(f"/api/store?rev={rev}"))
    assert data["changed"] is True
    assert data["rev"] == rev + 1
    assert [f["name"] for f in data["folders"]] == ["项目"]


def test_pull_with_garbage_rev_is_full(alice):
    mkfolder(alice, "工作")
    data = ok(alice.get("/api/store?rev=abc"))
    assert data["changed"] is True and len(data["folders"]) == 1


# ── 文件夹 CRUD ──────────────────────────────────────────

def test_create_root_and_nested_folders(alice):
    root = mkfolder(alice, "项目")
    child = mkfolder(alice, "配置", root["id"])
    assert root["parent_id"] is None and root["order"] == 0
    assert child["parent_id"] == root["id"] and child["order"] == 0

    sibling = mkfolder(alice, "工作")
    assert sibling["order"] == 1  # 同级递增


def test_rename_folder(alice):
    folder = mkfolder(alice, "项目")
    data = ok(alice.patch(f"/api/store/folders/{folder['id']}", json={"name": "项目2"}))
    assert data["folder"]["name"] == "项目2"
    assert data["rev"] == 2


def test_move_folder_between_parents_and_back_to_root(alice):
    a = mkfolder(alice, "A")
    b = mkfolder(alice, "B")
    child = mkfolder(alice, "child", a["id"])

    moved = ok(alice.patch(f"/api/store/folders/{child['id']}", json={"parent_id": b["id"]}))["folder"]
    assert moved["parent_id"] == b["id"] and moved["order"] == 0

    back = ok(alice.patch(f"/api/store/folders/{child['id']}", json={"parent_id": None}))["folder"]
    assert back["parent_id"] is None
    assert back["order"] == 2  # 根级已有 A、B


def test_update_order(alice):
    folder = mkfolder(alice, "A")
    data = ok(alice.patch(f"/api/store/folders/{folder['id']}", json={"order": 7}))
    assert data["folder"]["order"] == 7


def test_folder_name_validation(alice):
    err(alice.post("/api/store/folders", json={"name": "   "}), "validation_error", 400)
    err(alice.post("/api/store/folders", json={"name": "x" * 61}), "validation_error", 400)


def test_unknown_parent_is_404(alice):
    err(alice.post("/api/store/folders", json={"name": "A", "parent_id": "f_deadbeef0000"}), "not_found", 404)


def test_patch_unknown_folder_is_404(alice):
    err(alice.patch("/api/store/folders/f_deadbeef0000", json={"name": "A"}), "not_found", 404)


# ── 成环与深度 ───────────────────────────────────────────

def test_move_parent_under_its_own_child_conflicts(alice):
    parent = mkfolder(alice, "父")
    child = mkfolder(alice, "子", parent["id"])
    err(alice.patch(f"/api/store/folders/{parent['id']}", json={"parent_id": child["id"]}), "conflict", 409)


def test_move_folder_into_itself_conflicts(alice):
    folder = mkfolder(alice, "自己")
    err(alice.patch(f"/api/store/folders/{folder['id']}", json={"parent_id": folder["id"]}), "conflict", 409)


def test_depth_limit_on_create(alice):
    from app import validators

    deepest = chain(alice, validators.MAX_TREE_DEPTH)[-1]
    response = alice.post("/api/store/folders", json={"name": "第九层", "parent_id": deepest["id"]})
    err(response, "quota_exceeded", 409)


def test_move_that_would_exceed_depth(alice):
    deep = chain(alice, 6, "d")[-1]          # 深度 6
    tall = chain(alice, 3, "t")[0]           # 高度 3 的子树，整体搬走
    err(alice.patch(f"/api/store/folders/{tall['id']}", json={"parent_id": deep["id"]}), "quota_exceeded", 409)

    # 失败的移动不能留下痕迹
    folders = {f["id"]: f for f in snapshot(alice)["folders"]}
    assert folders[tall["id"]]["parent_id"] is None


# ── 删除文件夹 ───────────────────────────────────────────

def test_delete_folder_promotes_children_by_default(alice):
    parent = mkfolder(alice, "父")
    child = mkfolder(alice, "子", parent["id"])
    item = mkitem(alice, "内容", folder_id=parent["id"])

    data = ok(alice.delete(f"/api/store/folders/{parent['id']}"))
    assert (data["deleted_folders"], data["deleted_items"]) == (1, 0)

    after = snapshot(alice)
    assert [f["id"] for f in after["folders"]] == [child["id"]]
    assert after["folders"][0]["parent_id"] is None
    assert after["items"][0]["id"] == item["id"] and after["items"][0]["folder_id"] is None


def test_delete_folder_cascade(alice):
    parent = mkfolder(alice, "父")
    child = mkfolder(alice, "子", parent["id"])
    mkitem(alice, "a", folder_id=parent["id"])
    mkitem(alice, "b", folder_id=child["id"])
    survivor = mkitem(alice, "c")

    data = ok(alice.delete(f"/api/store/folders/{parent['id']}?cascade=true"))
    assert (data["deleted_folders"], data["deleted_items"]) == (2, 2)

    after = snapshot(alice)
    assert after["folders"] == []
    assert [i["id"] for i in after["items"]] == [survivor["id"]]


def test_delete_folder_cascade_flag_parsing(alice):
    parent = mkfolder(alice, "父")
    mkfolder(alice, "子", parent["id"])
    data = ok(alice.delete(f"/api/store/folders/{parent['id']}?cascade=YES"))
    assert data["deleted_folders"] == 2

    other = mkfolder(alice, "另一个父")
    mkfolder(alice, "另一个子", other["id"])
    data = ok(alice.delete(f"/api/store/folders/{other['id']}?cascade=0"))
    assert data["deleted_folders"] == 1


def test_delete_unknown_folder_is_404(alice):
    err(alice.delete("/api/store/folders/f_deadbeef0000"), "not_found", 404)


# ── 条目 ─────────────────────────────────────────────────

def test_create_item_defaults_title(alice):
    item = mkitem(alice, "PORT=8420", title="")
    assert item["title"] == "未命名"
    assert item["folder_id"] is None and item["pinned"] is False
    assert item["created_at"] == item["updated_at"]

    assert mkitem(alice, "x")["title"] == "未命名"  # 完全不传 title 也一样


def test_create_item_requires_content(alice):
    err(alice.post("/api/store/items", json={"title": "只有标题"}), "validation_error", 400)


def test_edit_item(alice):
    item = mkitem(alice, "old", title="旧")
    data = ok(alice.patch(f"/api/store/items/{item['id']}", json={"title": "新", "content": "new"}))
    assert data["item"]["title"] == "新" and data["item"]["content"] == "new"
    assert data["item"]["updated_at"] >= item["updated_at"]


def test_move_item_between_folders(alice):
    folder = mkfolder(alice, "配置")
    item = mkitem(alice, "c")
    moved = ok(alice.patch(f"/api/store/items/{item['id']}", json={"folder_id": folder["id"]}))["item"]
    assert moved["folder_id"] == folder["id"]

    back = ok(alice.patch(f"/api/store/items/{item['id']}", json={"folder_id": None}))["item"]
    assert back["folder_id"] is None


def test_move_item_to_unknown_folder_is_404(alice):
    item = mkitem(alice, "c")
    err(alice.patch(f"/api/store/items/{item['id']}", json={"folder_id": "f_deadbeef0000"}), "not_found", 404)


def test_create_item_in_unknown_folder_is_404(alice):
    err(alice.post("/api/store/items", json={"content": "c", "folder_id": "f_deadbeef0000"}), "not_found", 404)


def test_pin_item(alice):
    item = mkitem(alice, "c")
    data = ok(alice.patch(f"/api/store/items/{item['id']}", json={"pinned": True}))
    assert data["item"]["pinned"] is True


def test_delete_item(alice):
    item = mkitem(alice, "c")
    rev = ok(alice.delete(f"/api/store/items/{item['id']}"))["rev"]
    assert snapshot(alice) == {"changed": True, "rev": rev, "folders": [], "items": [], "inbox_count": 0}
    err(alice.delete(f"/api/store/items/{item['id']}"), "not_found", 404)


def test_item_length_limits(alice):
    from app import validators

    too_long = "x" * (validators.MAX_CONTENT_LEN + 1)
    err(alice.post("/api/store/items", json={"content": too_long}), "validation_error", 400)
    err(
        alice.post("/api/store/items", json={"content": "c", "title": "t" * (validators.MAX_TITLE_LEN + 1)}),
        "validation_error",
        400,
    )

    item = mkitem(alice, "c")
    err(alice.patch(f"/api/store/items/{item['id']}", json={"content": too_long}), "validation_error", 400)


def test_pinned_items_sort_first(alice):
    first = mkitem(alice, "1")
    second = mkitem(alice, "2")
    third = mkitem(alice, "3")
    ok(alice.patch(f"/api/store/items/{first['id']}", json={"pinned": True}))

    order = [i["id"] for i in snapshot(alice)["items"]]
    assert order[0] == first["id"]
    assert set(order[1:]) == {second["id"], third["id"]}


def test_folders_sorted_by_parent_and_order(alice):
    root = mkfolder(alice, "root")
    second = mkfolder(alice, "second", root["id"])
    first = mkfolder(alice, "first", root["id"])
    ok(alice.patch(f"/api/store/folders/{first['id']}", json={"order": 0}))
    ok(alice.patch(f"/api/store/folders/{second['id']}", json={"order": 1}))

    names = [f["name"] for f in snapshot(alice)["folders"]]
    assert names == ["root", "first", "second"]


# ── 空 PATCH 不递增 rev ──────────────────────────────────

def test_empty_patch_does_not_bump_rev(alice):
    folder = mkfolder(alice, "A")
    item = mkitem(alice, "c")
    rev = snapshot(alice)["rev"]

    assert ok(alice.patch(f"/api/store/folders/{folder['id']}", json={}))["rev"] == rev
    assert ok(alice.patch(f"/api/store/items/{item['id']}", json={}))["rev"] == rev
    # 传了值但与现状相同，同样不算改动
    assert ok(alice.patch(f"/api/store/folders/{folder['id']}", json={"name": "A"}))["rev"] == rev
    assert ok(alice.patch(f"/api/store/items/{item['id']}", json={"pinned": False}))["rev"] == rev
    assert snapshot(alice)["rev"] == rev


# ── 越权隔离 ─────────────────────────────────────────────

def test_cross_user_access_is_404_and_leaves_data_intact(alice, bob):
    folder = mkfolder(bob, "bob 的文件夹")
    item = mkitem(bob, "bob 的内容", title="bob", folder_id=folder["id"])
    before = snapshot(bob)

    err(alice.patch(f"/api/store/folders/{folder['id']}", json={"name": "劫持"}), "not_found", 404)
    err(alice.delete(f"/api/store/folders/{folder['id']}"), "not_found", 404)
    err(alice.patch(f"/api/store/items/{item['id']}", json={"content": "劫持"}), "not_found", 404)
    err(alice.delete(f"/api/store/items/{item['id']}"), "not_found", 404)
    err(alice.post("/api/store/items", json={"content": "c", "folder_id": folder["id"]}), "not_found", 404)
    err(alice.post("/api/store/folders", json={"name": "x", "parent_id": folder["id"]}), "not_found", 404)

    assert snapshot(bob) == before
    assert snapshot(alice)["folders"] == [] and snapshot(alice)["items"] == []


# ── 认证 ─────────────────────────────────────────────────

def test_all_endpoints_require_auth(anon):
    err(anon.get("/api/store"), "unauthorized", 401)
    err(anon.post("/api/store/folders", json={"name": "A"}), "unauthorized", 401)
    err(anon.patch("/api/store/folders/f_1", json={"name": "A"}), "unauthorized", 401)
    err(anon.delete("/api/store/folders/f_1"), "unauthorized", 401)
    err(anon.post("/api/store/items", json={"content": "c"}), "unauthorized", 401)
    err(anon.patch("/api/store/items/i_1", json={"content": "c"}), "unauthorized", 401)
    err(anon.delete("/api/store/items/i_1"), "unauthorized", 401)
