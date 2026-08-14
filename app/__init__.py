"""ClipNest 应用工厂。"""

from pathlib import Path

from flask import Flask

from app.bootstrap import bootstrap
from app.errors import register_error_handlers
from app.validators import MAX_REQUEST_BYTES

BASE_DIR = Path(__file__).resolve().parent.parent


def create_app(*, verbose_bootstrap: bool = True) -> Flask:
    app = Flask(
        __name__,
        static_folder=str(BASE_DIR / "static"),
        static_url_path="/static",
        template_folder=str(BASE_DIR / "templates"),
    )
    app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_BYTES
    app.config["JSON_AS_ASCII"] = False
    app.json.ensure_ascii = False
    # 静态资源每次都回源校验（带 ETag，未改动仍是 304，几乎不费流量）。
    # Flask 默认给 12 小时强缓存，页面结构一变就会出现"刷新了还是旧的"，
    # 更糟的是浏览器连 404 也一起缓存：某个新文件在上线前的空窗期被请求过一次，
    # 之后好几个小时都不会再去取它。这种问题排查起来极浪费时间，不值得为
    # 这点带宽省下的开销买单。
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

    bootstrap(verbose=verbose_bootstrap)
    register_error_handlers(app)

    # 蓝图在函数内导入：避免模块级循环依赖，也让 bootstrap 先于路由完成
    from app.api.admin import bp as admin_bp
    from app.api.auth import bp as auth_bp
    from app.api.share import bp as share_bp
    from app.api.share import public_bp
    from app.api.store import bp as store_bp
    from app.web import bp as web_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(store_bp)
    app.register_blueprint(share_bp)
    app.register_blueprint(public_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(web_bp)

    return app
