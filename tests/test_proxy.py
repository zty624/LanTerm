from dataclasses import replace

from starlette.requests import HTTPConnection

from terminal.app import Auth


def connection(origin: str) -> HTTPConnection:
    return HTTPConnection(
        {
            "type": "websocket",
            "scheme": "ws",
            "path": "/ws/example",
            "query_string": b"",
            "headers": [(b"host", b"127.0.0.1:8766"), (b"origin", origin.encode())],
            "server": ("127.0.0.1", 8766),
        }
    )


async def test_https_proxy_origin_is_explicit_and_other_origins_stay_blocked(server):
    direct = Auth(server.config)
    assert not direct.origin_ok(connection("https://gateway.example"))
    proxied = Auth(
        replace(server.config, public_url="https://gateway.example/notebook/proxy/8766/")
    )
    assert proxied.origin_ok(connection("https://gateway.example"))
    assert not proxied.origin_ok(connection("https://untrusted.example"))
    assert not proxied.origin_ok(connection("http://gateway.example"))
