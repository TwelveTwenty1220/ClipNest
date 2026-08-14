"""文件夹与条目 API —— 见 docs/API.md 第 4 节。"""

from flask import Blueprint

bp = Blueprint("store", __name__, url_prefix="/api/store")
