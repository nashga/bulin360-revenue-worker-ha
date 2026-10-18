"""Bulín Puertas · app de Home Assistant (1.0.0) · El Bulín.

Hace de puente entre las cerraduras de la casa y el Panel de El Bulín, sin Availroom:
  · descubre las cerraduras de este HA (lock.*: Nuki, Danalock por Z-Wave…) y los Shelly que abren portales (solo pulsar);
  · envía su estado al Panel cada 60 s y recoge cada 5 s las órdenes de abrir o cerrar del Panel o del Control
    (conexión solo de salida: no hay que abrir puertos);
  · ofrece el panel «Puertas» en la barra lateral de HA para abrir y cerrar en local (también se registra en el Panel).
Solo biblioteca estándar de Python. Las órdenes van al API de Home Assistant con el token del Supervisor.
"""
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0.4"
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
OPTIONS_FILE = os.environ.get("BULIN_OPTIONS", "/data/options.json")
HA = os.environ.get("BULIN_HA_API", "http://supervisor/core/api")
def _sup_token():
    """Token del Supervisor: en el entorno o, con s6-overlay, en /run/s6/container_environment (1.0.2)."""
    t = os.environ.get("SUPERVISOR_TOKEN", "")
    if not t:
        for f in ("/run/s6/container_environment/SUPERVISOR_TOKEN", "/var/run/s6/container_environment/SUPERVISOR_TOKEN"):
            try:
                with open(f, encoding="utf-8") as fh:
                    t = fh.read().strip()
                if t:
                    break
            except OSError:
                pass
    return t


SUP_TOKEN = _sup_token()
PORT = int(os.environ.get("BULIN_PORT", "8099"))
INGRESS_IPS = {"172.30.32.2", "127.0.0.1"}
TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png"}
POLL_SECONDS, SYNC_SECONDS = 5, 60  # valores por defecto; el Panel puede indicar otros en cada sincronización
TIMING = {"poll": POLL_SECONDS, "sync": SYNC_SECONDS}
DATA_DIR = os.environ.get("BULIN_DATA", "/data")
EVENTS_BACKFILL_DAYS = 10   # la primera vez se envía lo que el HA guarde (por defecto unos 10 días)
EVENTS_MAX_PER_SYNC = 300

# Jinja de HA: cerraduras con su dispositivo (fabricante, modelo, entidades hermanas) y los switch de la integración Shelly
TEMPLATE = """{% set out = namespace(l=[], p=[]) %}{% for s in states.lock %}{% set d = device_id(s.entity_id) %}{% set out.l = out.l + [{'e': s.entity_id, 'name': s.name, 'state': s.state, 'sf': s.attributes.supported_features | default(0), 'maker': (device_attr(d, 'manufacturer') if d else '') or '', 'model': (device_attr(d, 'model') if d else '') or '', 'ents': (device_entities(d) if d else [])}] %}{% endfor %}{% for e in integration_entities('shelly') | select('match', 'switch\\\\.') %}{% set d = device_id(e) %}{% set out.p = out.p + [{'e': e, 'name': state_attr(e, 'friendly_name') or e, 'state': states(e), 'model': (device_attr(d, 'model') if d else '') or 'Shelly'}] %}{% endfor %}{{ {'locks': out.l, 'portals': out.p} | to_json }}"""

STATE = {"panel": {"configured": False, "connected": False, "error": None, "device": None, "last_sync": None, "last_poll": None},
         "properties": [], "links": {}, "spaces": [], "space_links": {}, "hidden": [], "local_error": None, "commands_done": 0}
LOCK = threading.Lock()
WAKE = threading.Event()


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def options():
    try:
        with open(OPTIONS_FILE, encoding="utf-8") as f:
            o = json.load(f)
    except Exception:
        o = {}
    o.setdefault("panel_url", "https://www.elbulin.es/operaciones/admin-nuevo/api/")
    o.setdefault("panel_token", "")
    o.setdefault("portals", [])
    o.setdefault("hide", [])
    o.setdefault("confirm", True)
    return o


def http(method, url, body=None, headers=None, timeout=20):
    data = None if body is None else json.dumps(body).encode()
    # 1.0.1 · agente identificable tipo navegador: algunos cortafuegos de hosting rechazan «Python-urllib» con un 403
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", "Accept": "application/json, */*;q=0.5", "Accept-Language": "es-ES,es;q=0.9",
                                                                         "User-Agent": f"Mozilla/5.0 (compatible; BulinPuertas/{VERSION}; +https://www.elbulin.es)", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode()


def ha(method, path, body=None):
    global SUP_TOKEN
    if not SUP_TOKEN:
        SUP_TOKEN = _sup_token()
    st, raw = http(method, HA + path, body, {"Authorization": f"Bearer {SUP_TOKEN}"})
    if st == 0 or st >= 400:
        raise RuntimeError(f"Home Assistant {st}: {raw[:160].decode('utf-8', 'replace')}")
    return raw


def panel(method, path, body=None, timeout=20):
    o = options()
    st, raw = http(method, o["panel_url"].rstrip("/") + "/" + path, body, {"Authorization": f"Bearer {o['panel_token']}", "X-Bulin-Token": o["panel_token"], "X-Bulin-App": f"puertas-{VERSION}"}, timeout)
    try:
        j = json.loads(raw.decode() or "{}")
    except Exception:
        j = {}
    if st == 0:
        raise ConnectionError(raw.decode("utf-8", "replace")[:160])
    if st >= 400 or not j.get("ok", False):
        detail = j.get("error") or (raw[:120].decode("utf-8", "replace").strip().replace("\n", " ") if not j else "")
        e = RuntimeError(f"Panel {st}: {detail}" if detail else f"Panel {st}")
        e.status = st
        raise e
    return j


def num(v):
    try:
        return round(float(v))
    except Exception:
        return None


def discover():
    """Cerraduras y portales de este HA con su estado (lo que se envía al Panel y lo que pinta el panel local)."""
    o = options()
    hide = set(o.get("hide") or []) | set(STATE["hidden"])
    states = {s["entity_id"]: s for s in json.loads(ha("GET", "/states").decode())}
    try:
        data = json.loads(ha("POST", "/template", {"template": TEMPLATE}).decode() or "{}")
        STATE["template_error"] = None
    except Exception as ex:
        # 1.0.2 · si la plantilla falla (versión de HA, permisos…), se descubre solo con los estados: cerraduras lock.* y switch.* de Shelly por nombre
        if STATE.get("template_error") != str(ex)[:160]:
            log("Aviso: no se pudo usar la plantilla de HA; uso solo los estados.", str(ex)[:160])
        STATE["template_error"] = str(ex)[:160]
        data = {"locks": [], "portals": []}
        for e, st in states.items():
            a = st.get("attributes", {})
            if e.startswith("lock."):
                obj = e.split(".", 1)[1]
                ents = [x for x in states if x.split(".", 1)[1].startswith(obj + "_") or x.split(".", 1)[1] == obj]
                data["locks"].append({"e": e, "name": a.get("friendly_name") or e, "state": st.get("state"), "sf": a.get("supported_features", 0), "maker": "", "model": "", "ents": ents})
            elif e.startswith("switch.") and "shelly" in e.lower():
                data["portals"].append({"e": e, "name": a.get("friendly_name") or e, "state": st.get("state"), "model": "Shelly"})
    out = []
    watch = {}  # 1.0.4 · entidades cuyo historial se envía al Panel: entidad → (cerradura o portal, tipo)
    for l in data.get("locks", []):
        if l["e"] in hide:
            continue
        watch[l["e"]] = (l["e"], "lock")
        bat = door = None
        jammed = dead = False
        for e in l.get("ents") or []:
            s = states.get(e)
            if not s:
                continue
            a, low = s.get("attributes", {}), e.lower()
            dc = a.get("device_class")
            if e.startswith("sensor.") and (dc == "battery" or "battery" in low or "bateria" in low) and bat is None:
                bat = num(s["state"])
            elif e.startswith("binary_sensor.") and (dc in ("door", "opening") or "status_of_the_door" in low or "puerta" in low):
                door = s["state"] == "on"
                watch[e] = (l["e"], "door")
            elif e.startswith("binary_sensor.") and "jam" in low:
                jammed = s["state"] == "on"
                watch[e] = (l["e"], "jammed")
            elif e.startswith("sensor.") and ("node_status" in low or "estado_del_nodo" in low):
                dead = s["state"] == "dead"
        if bat is None:
            bat = num(states.get(l["e"], {}).get("attributes", {}).get("battery_level"))
        st = l["state"]
        out.append({"entity_id": l["e"], "kind": "lock", "name": l["name"], "model": l.get("model") or l.get("maker") or "", "state": st, "battery": bat, "door_open": door,
                    "jammed": jammed or st == "jammed", "offline": dead or st in ("unavailable", "unknown"), "can_open": bool(int(l.get("sf") or 0) & 1)})
    seen = {x["entity_id"] for x in out}
    portals = list(data.get("portals", [])) + [{"e": (p or {}).get("entity_id", ""), "name": (p or {}).get("name") or "", "model": "", "state": None} for p in (o.get("portals") or [])]
    for p in portals:
        e = (p.get("e") or "").strip()
        if not e or e in hide or e in seen or e.split(".")[0] not in ("switch", "button", "script"):
            continue
        seen.add(e)
        watch[e] = (e, "portal")
        s = states.get(e, {})
        st = s.get("state", "unavailable")
        out.append({"entity_id": e, "kind": "portal", "name": p.get("name") or s.get("attributes", {}).get("friendly_name") or e, "model": p.get("model") or "",
                    "state": st, "battery": None, "door_open": None, "jammed": False, "offline": st in ("unavailable",) and not e.startswith(("button.", "script.")), "can_open": True})
    out.sort(key=lambda x: (x["kind"], x["name"].lower()))
    STATE["watch"] = watch
    return out, states


def _cursor_file():
    d = DATA_DIR if os.path.isdir(DATA_DIR) else os.environ.get("TMPDIR", "/tmp")
    return os.path.join(d, "bulin_puertas_events.json")


def load_cursor():
    try:
        with open(_cursor_file(), encoding="utf-8") as f:
            return json.load(f).get("since")
    except Exception:
        return None


def save_cursor(since):
    try:
        with open(_cursor_file(), "w", encoding="utf-8") as f:
            json.dump({"since": since}, f)
    except Exception as e:
        log("No se pudo guardar el cursor del historial:", e)


EV_VALUES = {"lock": {"locked", "unlocked", "open", "opening", "jammed", "unavailable"}, "door": {"on", "off"}, "jammed": {"on"}, "portal": {"on"}}


def collect_events():
    """1.0.4 · Movimientos de las cerraduras desde el historial de HA (abrir/cerrar venga de donde venga, puerta, atasco, portales).
    Devuelve (eventos, nuevo_cursor). El cursor solo avanza cuando el Panel los ha recibido."""
    watch = STATE.get("watch") or {}
    if not watch:
        return [], None
    since = load_cursor() or time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() - EVENTS_BACKFILL_DAYS * 86400))
    now = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
    q = urllib.parse.urlencode({"filter_entity_id": ",".join(sorted(watch)), "end_time": now})
    rows = json.loads(ha("GET", f"/history/period/{urllib.parse.quote(since)}?{q}").decode() or "[]")
    t0 = _ts(since)
    evs = []
    for series in rows or []:
        for h in series or []:
            e = h.get("entity_id")
            if e not in watch or _ts(h.get("last_changed")) <= t0:
                continue
            target, kind = watch[e]
            v = h.get("state")
            if v not in EV_VALUES[kind]:
                continue
            ctx = h.get("context") or {}
            evs.append({"entity_id": target, "kind": kind, "value": {"on": "open", "off": "closed"}.get(v, v) if kind == "door" else v,
                        "at": h.get("last_changed"), "ha_user": bool(ctx.get("user_id")), "ctx": (ctx.get("id") or "")[:40]})
    evs.sort(key=lambda x: _ts(x["at"]))
    if len(evs) > EVENTS_MAX_PER_SYNC:
        evs = evs[:EVENTS_MAX_PER_SYNC]
        return evs, evs[-1]["at"]
    return evs, now


def _ts(v):
    try:
        import datetime
        return datetime.datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def act(entity_id, action):
    """Ejecuta en HA. action: open | close. Devuelve (ok, mensaje, estado)."""
    items, _ = discover()
    it = next((x for x in items if x["entity_id"] == entity_id), None)
    if not it:
        return False, "Esa puerta no está en este Home Assistant (o está oculta).", None
    if it["kind"] == "portal":
        if action != "open":
            return False, "Un portal solo se abre.", None
        dom = entity_id.split(".")[0]
        ha("POST", f"/services/{dom}/{'press' if dom == 'button' else 'turn_on'}", {"entity_id": entity_id})
        return True, f"{it['name']}: pulsado", "on"
    if it["offline"]:
        return False, f"{it['name']} no tiene conexión con Home Assistant.", it["state"]
    service = "lock" if action == "close" else ("open" if it["can_open"] else "unlock")
    ha("POST", f"/services/lock/{service}", {"entity_id": entity_id})
    want = ("locked",) if action == "close" else ("unlocked", "open", "opening", "unlocking")
    st = it["state"]
    for _ in range(16):  # hasta ~8 s para ver el cambio (Z-Wave tarda)
        time.sleep(0.5)
        try:
            st = json.loads(ha("GET", f"/states/{entity_id}").decode()).get("state")
        except Exception:
            pass
        if st in want or st == "jammed":
            break
    if st == "jammed":
        return False, f"{it['name']}: bloqueada", st
    done = st in want
    return True, f"{it['name']}: {'abierta' if action == 'open' else 'cerrada'}" if done else f"{it['name']}: orden enviada, sin confirmar aún", st


def run_command(c):
    try:
        ok, msg, st = act(c["entity_id"], c["action"])
    except Exception as e:
        ok, msg, st = False, str(e)[:200], None
    log(f"Orden {c['id']} {c['action']} {c['entity_id']}: {'OK' if ok else 'ERROR'} {msg}")
    try:
        panel("POST", "doors/ha/result.php", {"command_id": c["id"], "ok": ok, "message": msg, "state": st})
    except Exception as e:
        log("No se pudo enviar el resultado:", e)
    STATE["commands_done"] += 1
    WAKE.set()


def apply_sync_response(j):
    with LOCK:
        STATE["panel"].update({"connected": True, "error": None, "device": (j.get("device") or {}).get("name")})
        if j.get("poll_seconds"):
            TIMING["poll"] = max(2, min(60, int(j["poll_seconds"])))
        if j.get("sync_seconds"):
            TIMING["sync"] = max(20, min(600, int(j["sync_seconds"])))
        if "properties" in j:
            STATE["properties"] = j.get("properties") or []
            STATE["links"] = j.get("links") or {}
            STATE["spaces"] = j.get("spaces") or []
            STATE["space_links"] = j.get("space_links") or {}
            STATE["hidden"] = j.get("hidden") or []
    for c in j.get("commands") or []:
        threading.Thread(target=run_command, args=(c,), daemon=True).start()


def bridge():
    """Bucle de conexión con el Panel: sincroniza cada 20 s (o tras una orden) y consulta órdenes cada 3 s."""
    last_sync, backoff = 0.0, TIMING["poll"]
    while True:
        o = options()
        STATE["panel"]["configured"] = bool(o.get("panel_token"))
        if not o.get("panel_token"):
            STATE["panel"].update({"connected": False, "error": "Falta el token del Panel en la configuración de la app."})
            WAKE.wait(30); WAKE.clear(); continue
        try:
            if time.time() - last_sync >= TIMING["sync"] or WAKE.is_set():
                WAKE.clear()
                try:
                    items, _ = discover()
                    STATE["local_error"] = None
                except Exception as e:
                    msg = f"No se pudieron leer las cerraduras de Home Assistant: {str(e)[:200]}"
                    if STATE["local_error"] != msg:
                        log(msg)
                    items, STATE["local_error"] = None, msg
                if items is not None:
                    hv = {}
                    try:
                        cfg = json.loads(ha("GET", "/config").decode())
                        hv = {"version": cfg.get("version"), "location": cfg.get("location_name")}
                    except Exception:
                        pass
                    try:
                        evs, cur = collect_events()
                    except Exception as e:
                        evs, cur = [], None
                        if STATE.get("events_error") != str(e)[:120]:
                            log("Aviso: no se pudo leer el historial de HA:", str(e)[:160])
                        STATE["events_error"] = str(e)[:120]
                    j = panel("POST", "doors/ha/sync.php", {"version": VERSION, "ha": hv, "entities": items, "events": evs})
                    if cur:
                        save_cursor(cur)
                        if evs:
                            log(f"Historial enviado al Panel: {len(evs)} movimientos")
                    n = (len([x for x in items if x["kind"] == "lock"]), len([x for x in items if x["kind"] == "portal"]))
                    if STATE.get("last_counts") != n:
                        log(f"Enviado al Panel: {n[0]} cerraduras y {n[1]} portales")
                        STATE["last_counts"] = n
                    STATE["panel"]["last_sync"] = time.strftime("%H:%M:%S")
                    apply_sync_response(j)
                    last_sync = time.time()
            j = panel("GET", "doors/ha/poll.php", timeout=15)
            STATE["panel"]["last_poll"] = time.strftime("%H:%M:%S")
            apply_sync_response(j)
            backoff = TIMING["poll"]
        except Exception as e:
            status = getattr(e, "status", 0)
            msg = "Token no válido o revocado: revísalo en el Panel." if status == 401 else f"Sin conexión con el Panel: {e}"
            if STATE["panel"]["error"] != msg:
                log(msg)
            STATE["panel"].update({"connected": False, "error": msg})
            backoff = min(60, backoff * 2) if status != 401 else 120
        WAKE.wait(backoff if not STATE["panel"]["connected"] else TIMING["poll"])


class H(BaseHTTPRequestHandler):
    server_version = f"BulinPuertas/{VERSION}"

    def log_message(self, fmt, *a):
        pass

    def _allowed(self):
        if self.client_address[0] not in INGRESS_IPS:
            self._json({"ok": False, "error": "Solo desde Home Assistant."}, 403)
            return False
        return True

    def _json(self, obj, status=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _user(self):
        return self.headers.get("X-Remote-User-Display-Name") or self.headers.get("X-Remote-User-Name") or ""

    def do_GET(self):
        if not self._allowed():
            return
        path = self.path.split("?")[0]
        if path == "/api/state":
            o = options()
            out = {"ok": True, "version": VERSION, "confirm": bool(o.get("confirm", True)), "panel": dict(STATE["panel"]), "properties": STATE["properties"], "links": STATE["links"], "spaces": STATE["spaces"], "space_links": STATE["space_links"], "user": self._user()}
            try:
                out["items"], _ = discover()
            except Exception as e:
                out["items"], out["local_error"] = [], str(e)[:200]
            return self._json(out)
        name = "index.html" if path in ("/", "") else path.lstrip("/")
        f = os.path.normpath(os.path.join(STATIC, name))
        if not f.startswith(STATIC) or not os.path.isfile(f):
            return self._json({"ok": False, "error": "No existe"}, 404)
        with open(f, "rb") as fh:
            b = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(os.path.splitext(f)[1], "application/octet-stream"))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        if not self._allowed():
            return
        if self.path.split("?")[0] != "/api/action":
            return self._json({"ok": False, "error": "No existe"}, 404)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            b = json.loads(self.rfile.read(min(n, 4096)).decode() or "{}")
        except Exception:
            return self._json({"ok": False, "error": "Petición no válida"}, 400)
        ent, action = str(b.get("entity_id") or ""), b.get("action")
        if action not in ("open", "close"):
            return self._json({"ok": False, "error": "Acción no válida"}, 400)
        try:
            ok, msg, st = act(ent, action)
        except Exception as e:
            ok, msg, st = False, str(e)[:200], None
        log(f"Local ({self._user() or 'HA'}) {action} {ent}: {'OK' if ok else 'ERROR'} {msg}")
        if options().get("panel_token"):
            user = self._user()
            threading.Thread(target=lambda: _safe_log(ent, action, ok, msg, user), daemon=True).start()
        WAKE.set()
        return self._json({"ok": ok, "message": msg, "state": st, **({} if ok else {"error": msg})}, 200 if ok else 502)


def _safe_log(ent, action, ok, msg, user):
    try:
        panel("POST", "doors/ha/log.php", {"entity_id": ent, "action": action, "ok": ok, "message": msg, "user": user})
    except Exception as e:
        log("No se pudo registrar en el Panel:", e)


if __name__ == "__main__":
    log(f"Bulín Puertas {VERSION} · puerto {PORT}")
    threading.Thread(target=bridge, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
