#!/usr/bin/env python3
"""
Prompt Forge Bridge — tiny local relay between the Prompt Forge HTML tool
and a ComfyUI custom node. Standard library only, no dependencies.

Run:   python promptforge_bridge.py [port]
Default port: 8199

Endpoints:
  POST /set_prompt   { "positive": "...", "negative": "..." }   <- called by the HTML tool
  GET  /get_prompt    -> { "positive": "...", "negative": "...", "updated_at": <epoch> }  <- called by the ComfyUI node

  POST /set_state    { ...full PromptForgeState JSON... }        <- optional, v2 additions
  GET  /get_state     -> last pushed state JSON (or {})          <- lets tools sync full state,
                                                                    not just compiled strings

The v1 endpoints are unchanged — the original PromptForgeBridge node and the
old HTML tool keep working against this file exactly as before.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {"positive": "", "negative": "", "updated_at": None}
FORGE_STATE = {"state": None, "updated_at": None}


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/get_prompt"):
            self._send_json(200, STATE)
        elif self.path.startswith("/get_state"):
            self._send_json(200, FORGE_STATE["state"] or {})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON"})
            return
        if self.path.startswith("/set_prompt"):
            STATE["positive"] = data.get("positive", "")
            STATE["negative"] = data.get("negative", "")
            STATE["updated_at"] = time.time()
            self._send_json(200, {"ok": True})
        elif self.path.startswith("/set_state"):
            FORGE_STATE["state"] = data
            FORGE_STATE["updated_at"] = time.time()
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"error": "not found"})

    def log_message(self, format, *args):
        print(f"[{time.strftime('%H:%M:%S')}] {self.command} {self.path}")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8199
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Prompt Forge bridge running on http://127.0.0.1:{port}")
    print("  GET  /get_prompt   (called by the ComfyUI node)")
    print("  POST /set_prompt   (called by the HTML tool)")
    print("  GET  /get_state    (optional full-state sync)")
    print("  POST /set_state    (optional full-state sync)")
    print("Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
