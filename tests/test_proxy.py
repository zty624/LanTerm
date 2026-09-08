import pytest
from test_terminal import command
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus


async def test_proxy_origin_allows_authenticated_http_and_terminal(server):
    origin = "https://gateway.example"
    headers = {"Origin": origin}
    response = await server.client.post("/api/login", headers=headers, json={"password": "wrong"})
    assert response.status_code == 401
    response = await server.client.post(
        "/api/login", headers=headers, json={"password": server.config.password}
    )
    response.raise_for_status()
    assert (await server.client.get("/api/config", headers=headers)).status_code == 200
    response = await server.client.post(
        "/api/sessions",
        headers=headers,
        json={"name": "proxy", "shell": "bash", "cwd": str(server.config.cwd)},
    )
    response.raise_for_status()
    sid = response.json()["id"]
    url = server.url.replace("http:", "ws:") + "/ws/" + sid
    token = server.client.cookies[server.config.cookie]
    cookie = f"{server.config.cookie}={token}"
    async with connect(url, origin=origin, additional_headers={"Cookie": cookie}) as ws:
        await command(ws, "printf 'proxy:%s\\n' working", b"proxy:working")

    with pytest.raises(InvalidStatus):
        async with connect(url, origin=origin):
            pytest.fail("Unauthenticated proxied WebSocket was accepted")

    server.app.state.auth.tokens[token] = 0
    assert (await server.client.get("/api/config", headers=headers)).status_code == 401
    with pytest.raises(InvalidStatus):
        async with connect(url, origin=origin, additional_headers={"Cookie": cookie}):
            pytest.fail("Expired login was accepted")
