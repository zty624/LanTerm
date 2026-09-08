from starlette.responses import RedirectResponse
from starlette.types import ASGIApp, Receive, Scope, Send


class PrefixMiddleware:
    """Accept a configured public prefix whether the proxy strips it or preserves it."""

    def __init__(self, app: ASGIApp, prefix: str):
        self.app = app
        self.prefix = prefix.rstrip("/")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket") or not self.prefix:
            await self.app(scope, receive, send)
            return
        path = scope["path"]
        if scope["type"] == "http" and path == self.prefix:
            await RedirectResponse(self.prefix + "/", status_code=308)(scope, receive, send)
            return
        if path.startswith(self.prefix + "/"):
            scope = {
                **scope,
                "path": path[len(self.prefix) :],
                "raw_path": scope.get("raw_path", b"")[len(self.prefix.encode()) :],
                "root_path": "",
            }
        await self.app(scope, receive, send)
