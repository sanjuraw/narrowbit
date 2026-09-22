#!/usr/bin/env python3
"""
Local Jev-compatible decision server backed by Decider (github.com/Mapika/decider),
an open reproduction of TypeSafe's Jev interface — same request/state/questions shape,
independently trained, Apache-2.0, weights on Hugging Face (Mapika/decider-2b, -35b-a3b, -0.8b).

Speaks the same shape as /v1/systemone, so Narrowbit's rerank.ts "local" provider works
against it unmodified:

    POST /v1/systemone
    { "model": "decider-2b", "state": "...", "questions": {"target": {"type": "choice", ...}} }
    -> { "answers": {"target": {"choice": "...", "probabilities": {...}, "confidence": ...}}, "usage": {...} }

Nothing leaves this machine. Install: pip install "git+https://github.com/Mapika/decider.git"
First run downloads weights from Hugging Face into ~/.cache/huggingface.
"""
import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

decider = None


def get_decider(repo, device):
    global decider
    if decider is None:
        import torch
        from decider.infer import Decider

        dtype = torch.float32 if device == "cpu" else torch.bfloat16  # fp32 only on CPU; bf16 on mps/cuda halves memory
        decider = Decider(repo, device=device, dtype=dtype)
    return decider


class Handler(BaseHTTPRequestHandler):
    repo = "Mapika/decider-2b"
    device = "cpu"

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[decider_server] {self.address_string()} {fmt % args}\n")

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "model": self.repo})
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
            result = get_decider(self.repo, self.device).system_one(state, questions)
        except Exception as e:
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})
        if not isinstance(result, dict):
            result = {"answers": result}
        result.setdefault("usage", {})
        result["usage"]["latency_ms"] = round((time.time() - t0) * 1000, 1)
        result.setdefault("model", self.repo)
        self._json(200, result)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8722)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--repo", default="Mapika/decider-2b", help="HF repo, e.g. Mapika/decider-2b, Mapika/decider-0.8b")
    ap.add_argument("--device", default="cpu", help="cpu, mps, or cuda")
    ap.add_argument("--warm", action="store_true")
    args = ap.parse_args()
    Handler.repo = args.repo
    Handler.device = args.device

    if args.warm:
        sys.stderr.write(f"[decider_server] loading {args.repo}…\n")
        get_decider(args.repo, args.device)
        sys.stderr.write("[decider_server] model loaded\n")

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write(f"[decider_server] listening on http://{args.host}:{args.port} (POST /v1/systemone, GET /health)\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
