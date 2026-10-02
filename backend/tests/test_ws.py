import json

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


@pytest.fixture
def client(tmp_path, monkeypatch):
    import app.main as main
    from app.config import Settings
    monkeypatch.setattr(main, "settings", Settings(supervisor_token="t", database_path=str(tmp_path / "w.db"), demo_mode=True))
    with TestClient(main.app) as c:
        yield c


def test_bad_token_closes_4401(client):
    with client.websocket_connect("/ws/office") as ws:
        ws.send_text(json.dumps({"event": "AUTH", "payload": {"token": "salah"}}))
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_text()
    assert exc.value.code == 4401


def test_hello_snapshot_and_goal(client):
    with client.websocket_connect("/ws/office") as ws:
        ws.send_text(json.dumps({"event": "AUTH", "payload": {"token": "t"}}))
        assert json.loads(ws.receive_text())["event"] == "HELLO"
        snap = json.loads(ws.receive_text())
        assert snap["event"] == "SNAPSHOT" and len(snap["payload"]["agents"]) == 70

        ws.send_text(json.dumps({"event": "PING", "payload": {"client_ts": 1}}))
        assert json.loads(ws.receive_text())["event"] == "PONG"

        ws.send_text(json.dumps({"event": "USER_INJECT_GOAL", "payload": {"prompt": "x"}}))
        assert json.loads(ws.receive_text())["payload"]["code"] == "INVALID_EVENT"

        ws.send_text(json.dumps({"event": "USER_INJECT_GOAL", "payload": {"prompt": "Buat landing page produk"}}))
        first = json.loads(ws.receive_text())
        assert first["event"] == "GOAL_UPDATED" and first["seq"] >= 1


def test_rest_requires_token(client):
    assert client.get("/api/v1/agents").status_code == 401
    r = client.get("/api/v1/agents", headers={"Authorization": "Bearer t"})
    assert r.status_code == 200 and len(r.json()) == 70


def test_artifact_path_traversal_blocked(client, tmp_path, monkeypatch):
    import app.main as main
    ws = tmp_path / "ws"
    (ws / "goal_1").mkdir(parents=True)
    (ws / "goal_1" / "REPORT.md").write_text("isi laporan")
    (tmp_path / "secret.txt").write_text("rahasia")
    object.__setattr__(main.settings, "workspace_path", str(ws))
    h = {"Authorization": "Bearer t"}
    assert client.get("/api/v1/artifacts/goal_1/REPORT.md", headers=h).text == "isi laporan"
    assert client.get("/api/v1/artifacts/goal_1/..%2F..%2Fsecret.txt", headers=h).status_code == 404
    assert client.get("/api/v1/artifacts/goal_1/../../secret.txt", headers=h).status_code == 404
    assert client.get("/api/v1/artifacts/goal_1/REPORT.md").status_code == 401


def test_event_history_survives_reconnect(client):
    """Log Live: kejadian tersimpan di DB dan bisa dimuat ulang lewat REST."""
    h = {"Authorization": "Bearer t"}
    assert client.post("/api/v1/goals", json={"prompt": "Buat landing page produk"}, headers=h).status_code == 201
    client.get("/api/v1/health")
    events = client.get("/api/v1/events", headers=h).json()
    assert events[0]["event"] == "GOAL_UPDATED" and events[0]["ts"] > 0
    assert all(e["event"] != "AGENT_STATE_UPDATE" for e in events)
    assert client.get("/api/v1/events").status_code == 401


def test_continue_project_and_delete(tmp_path, monkeypatch):
    """Lanjutan memakai salinan hasil versi sebelumnya (versi lama utuh); hapus hanya proyek selesai tanpa lanjutan."""
    import app.main as main
    from app.config import Settings
    ws_root = tmp_path / "ws"
    monkeypatch.setattr(main, "settings", Settings(supervisor_token="t", database_path=str(tmp_path / "w.db"),
                                                   workspace_path=str(ws_root), demo_mode=True))
    h = {"Authorization": "Bearer t"}
    with TestClient(main.app) as c:
        async def no_plan(goal_id):
            return None
        monkeypatch.setattr(main.state.orch, "plan_goal", no_plan)
        repo = main.state.repo
        c.portal.call(repo.create_goal, "goal_v1", "Buat website toko kopi", 2, False)
        (ws_root / "goal_v1" / "reports").mkdir(parents=True)
        (ws_root / "goal_v1" / "index.html").write_text("v1")
        (ws_root / "goal_v1" / "reports" / "E1.md").write_text("laporan")

        body = {"prompt": "Tambah halaman kontak", "parent_goal_id": "goal_v1"}
        assert c.post("/api/v1/goals", json=body, headers=h).status_code == 409
        c.portal.call(repo.set_goal, "goal_v1", "DONE")
        v2 = c.post("/api/v1/goals", json=body, headers=h).json()
        assert v2["parent_goal_id"] == "goal_v1"
        assert (ws_root / v2["goal_id"] / "index.html").read_text() == "v1"
        assert not (ws_root / v2["goal_id"] / "reports").exists()

        assert c.delete("/api/v1/goals/goal_v1", headers=h).status_code == 409
        assert c.delete(f"/api/v1/goals/{v2['goal_id']}", headers=h).status_code == 409
        c.portal.call(repo.set_goal, v2["goal_id"], "FAILED")
        assert c.delete(f"/api/v1/goals/{v2['goal_id']}", headers=h).status_code == 204
        assert (ws_root / "goal_v1" / "index.html").read_text() == "v1"
        assert c.delete("/api/v1/goals/goal_v1", headers=h).status_code == 204
        assert not (ws_root / "goal_v1").exists()
        assert c.get("/api/v1/goals", headers=h).json() == []
        assert c.get("/api/v1/goals/goal_v1/report", headers=h).status_code == 404


def test_delete_minutes_chat_log_and_fire_hired(client):
    """Hapus notulen, riwayat chat, Log Live; berhentikan hanya karyawan rekrutan tanpa task terbuka."""
    import app.main as main
    from app import hr
    h = {"Authorization": "Bearer t"}
    repo = main.state.repo
    c = client

    c.portal.call(repo.create_meeting, "meet_1", "ALL_HANDS", ["Progres"])
    assert c.delete("/api/v1/meetings/meet_1", headers=h).status_code == 409
    c.portal.call(repo.finish_meeting, "meet_1", "Notulen", "DONE")
    assert c.delete("/api/v1/meetings/meet_1", headers=h).status_code == 204
    assert c.delete("/api/v1/meetings/meet_1", headers=h).status_code == 404

    c.portal.call(repo.add_message, "chat:agent_ren", "human", "agent_ren", "user", "Halo Ren")
    assert c.get("/api/v1/agents/agent_ren/messages", headers=h).json()
    assert c.delete("/api/v1/agents/agent_ren/messages", headers=h).status_code == 204
    assert c.get("/api/v1/agents/agent_ren/messages", headers=h).json() == []

    assert c.delete("/api/v1/events", headers=h).status_code == 204
    assert c.get("/api/v1/events", headers=h).json() == []

    assert c.delete("/api/v1/agents/agent_ren", headers=h).status_code == 403
    desk = c.portal.call(repo.free_desk, "marketing")
    profile = hr.new_profile(number=71, used_names=set(), role="", division="marketing", skills=["tiktok ads"],
                             desk_id=desk, lead_id="agent_ryota")
    c.portal.call(repo.hire_agent, profile, None, "uji", "hrd")
    main.state.profiles[profile["agent_id"]] = profile
    agents = {a["agent_id"]: a for a in c.get("/api/v1/agents", headers=h).json()}
    assert agents[profile["agent_id"]]["hired"] == 1 and agents["agent_ren"]["hired"] == 0
    c.portal.call(repo.create_task, {"task_id": "t1", "title": "Iklan", "division": "marketing",
                                     "assigned_to": profile["agent_id"], "created_by": "human"})
    assert c.delete(f"/api/v1/agents/{profile['agent_id']}", headers=h).status_code == 409
    c.portal.call(lambda: repo.update_task("t1", status="DONE"))
    assert c.delete(f"/api/v1/agents/{profile['agent_id']}", headers=h).status_code == 204
    assert profile["agent_id"] not in {a["agent_id"] for a in c.get("/api/v1/agents", headers=h).json()}
    assert main.state.profiles[profile["agent_id"]]["fired"] is True
    assert c.portal.call(repo.free_desk, "marketing") == desk
    assert c.portal.call(repo.hire_counts, None) == (0, 0)


def test_goal_with_attachments(tmp_path, monkeypatch):
    """Lampiran bos tersimpan di references/; tipe berbahaya dan nama aneh ditolak/dibersihkan."""
    import base64
    import app.main as main
    from app.config import Settings
    ws_root = tmp_path / "ws"
    monkeypatch.setattr(main, "settings", Settings(supervisor_token="t", database_path=str(tmp_path / "w.db"),
                                                   workspace_path=str(ws_root), demo_mode=True))
    h = {"Authorization": "Bearer t"}
    b64 = lambda b: base64.b64encode(b).decode()
    with TestClient(main.app) as c:
        async def no_plan(goal_id):
            return None
        monkeypatch.setattr(main.state.orch, "plan_goal", no_plan)
        bad = {"prompt": "Buat website toko kopi", "attachments": [{"name": "x.exe", "data": b64(b"MZ")}]}
        assert c.post("/api/v1/goals", json=bad, headers=h).status_code == 415
        assert c.get("/api/v1/goals", headers=h).json() == []
        body = {"prompt": "Buat website toko kopi", "attachments": [
            {"name": "../../ref desain.png", "data": b64(b"\x89PNG")}, {"name": "brief.md", "data": b64(b"# Brief")}]}
        g = c.post("/api/v1/goals", json=body, headers=h).json()
        refs = ws_root / g["goal_id"] / "references"
        assert sorted(p.name for p in refs.iterdir()) == ["brief.md", "ref_desain.png"]


def test_preview_only_for_done_goals_with_html(client, monkeypatch, tmp_path):
    import app.main as main
    from app import vision
    h = {"Authorization": "Bearer t"}
    repo = main.state.repo
    c = client
    c.portal.call(repo.create_goal, "goal_p", "Buat website toko kopi", 2, False)
    assert c.get("/api/v1/goals/goal_p/preview", headers=h).status_code == 404
    c.portal.call(repo.set_goal, "goal_p", "DONE")
    shot = tmp_path / "preview.jpg"
    shot.write_bytes(b"\xff\xd8jpeg")

    async def fake_preview(workspace):
        return shot
    monkeypatch.setattr(vision, "make_preview", fake_preview)
    r = c.get("/api/v1/goals/goal_p/preview", headers=h)
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg" and r.content == b"\xff\xd8jpeg"
