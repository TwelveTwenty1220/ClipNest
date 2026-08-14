"""页面路由 —— 见 docs/API.md 第 7 节。"""

from flask import Blueprint, render_template

bp = Blueprint("web", __name__)


@bp.get("/")
def index():
    return render_template("index.html")


@bp.get("/s/<token>")
def public_share(token: str):
    return render_template("share.html", token=token)


@bp.get("/healthz")
def healthz():
    return {"ok": True}
