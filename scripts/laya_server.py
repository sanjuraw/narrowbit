#!/usr/bin/env python3
"""
Local Jev-compatible decision server backed by Laya (github.com/NandhaKishorM/laya),
an open-weights, Apache-2.0, locally-run "System One" decision model.

Speaks the same request/response shape as TypeSafe's /v1/systemone, so Narrowbit's
existing rerank.ts client works against it unmodified with provider "local":

    POST /v1/systemone
    { "model": "laya", "state": "...", "questions": {"target": {"type": "choice", ...}} }
    -> { "answers": {"target": {"choice": "...", "probabilities": {...}, "confidence": ...}}, "usage": {...} }

Nothing leaves this machine: the model, the weights and the HTTP server all run locally.
Requires the `laya` package (pip install laya); first run downloads model weights from
Hugging Face and caches them under ~/.cache/huggingface.
"""
import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

router = None  # loaded lazily so --help doesn't pull in torch


def get_router():
    global router
    if router is None:
        from laya import Router

        router = Router()
    return router


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[laya_server] {self.address_string()} {fmt % args}\n")

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "model": "laya"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/systemone":
            return self._json(404, {"error": f"unknown path {self.path}"})
        try:
            length = int(self.headers.get("content-length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            return self._json(400, {"error": f"bad request body: {e}"})

        state = body.get("state", "")
        questions = body.get("questions", {})
        if not state or not questions:
            return self._json(400, {"error": "state and questions are required"})

        t0 = time.time()
        try:
            result = get_router().predict(state, questions)
        except Exception as e:
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})
        result.setdefault("usage", {})
        result["usage"]["latency_ms"] = round((time.time() - t0) * 1000, 1)
        self._json(200, result)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8721)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--warm", action="store_true", help="load the model immediately instead of on first request")
    args = ap.parse_args()

    if args.warm:
        sys.stderr.write("[laya_server] loading model…\n")
        r = get_router()
        # Router.predict lazy-loads the per-language checkpoint on first call; force that now
        # rather than paying ~20s on the first real request.
        r.predict("warm-up", {"q": {"type": "noul", "instructions": "placeholder"}})
        sys.stderr.write("[laya_server] model loaded\n")

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write(f"[laya_server] listening on http://{args.host}:{args.port} (POST /v1/systemone, GET /health)\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
