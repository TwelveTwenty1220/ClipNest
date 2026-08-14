"""管理员 API —— 见 docs/API.md 第 6 节。"""

from flask import Blueprint

bp = Blueprint("admin", __name__, url_prefix="/api/admin")
