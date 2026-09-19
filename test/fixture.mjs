// Builds a realistic throwaway TypeScript repo (payments/auth app + unrelated feature modules) with git history.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FILES = {
  "package.json": JSON.stringify(
    {
      name: "shop-api",
      private: true,
      scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
      dependencies: { express: "^4.19.0", razorpay: "^2.9.0" },
      devDependencies: { typescript: "^5.5.0", vitest: "^2.0.0" },
    },
    null,
    2,
  ),
  "tsconfig.json": `{
  // comments are allowed in tsconfig
  "compilerOptions": { "target": "ES2022", "module": "ESNext", "strict": true, "baseUrl": ".", "paths": { "@/*": ["src/*"] } },
  "include": ["src", "tests"]
}`,
  ".env": "RAZORPAY_KEY_SECRET=super_secret_value_123456\n",
  "README.md": "# Shop API\n\nExpress API for orders, payments (Razorpay) and auth.\n",
  "src/server.ts": `import express from "express";
import { rawBodyMiddleware } from "./middleware/rawBody";
import { requireAuth } from "./middleware/auth";
import { handleWebhook } from "./payments/callback";
import { createOrderHandler } from "./orders/create";
import { refreshSessionHandler } from "@/auth/session";

export const app = express();

app.post("/webhooks/razorpay", rawBodyMiddleware, handleWebhook);
app.post("/orders", requireAuth, createOrderHandler);
app.post("/auth/refresh", refreshSessionHandler);
`,
  "src/middleware/rawBody.ts": `import type { Request, Response, NextFunction } from "express";

/** Capture the exact request bytes so webhook signatures can be verified. */
export function rawBodyMiddleware(req: Request & { rawBody?: string }, _res: Response, next: NextFunction) {
  let data = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => (data += chunk));
  req.on("end", () => {
    req.rawBody = data;
    try {
      req.body = JSON.parse(data || "{}");
    } catch {
      req.body = {};
    }
    next();
  });
}
`,
  "src/middleware/auth.ts": `import type { Request, Response, NextFunction } from "express";
import { validateToken } from "../auth/token";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.replace(/^Bearer /, "");
  if (!validateToken(token)) return res.status(401).json({ error: "unauthorized" });
  next();
}
`,
  "src/payments/verify.ts": `import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Razorpay webhook signature: HMAC-SHA256 of the raw body with the webhook secret.
 */
export function verifyPaymentSignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyOrderSignature(orderId: string, paymentId: string, signature: string, secret: string): boolean {
  return verifyPaymentSignature(\`\${orderId}|\${paymentId}\`, signature, secret);
}
`,
  "src/payments/callback.ts": `import type { Request, Response } from "express";
import { verifyPaymentSignature } from "./verify";
import { PaymentService } from "./service";

const service = new PaymentService();

export async function handleWebhook(req: Request & { rawBody?: string }, res: Response) {
  const signature = String(req.headers["x-razorpay-signature"] ?? "");
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
  // Re-serialising the parsed body changes bytes (key order, whitespace) — signature mismatch.
  const payload = JSON.stringify(req.body);
  if (!verifyPaymentSignature(payload, signature, secret)) {
    return res.status(400).json({ error: "signature mismatch" });
  }
  await service.markPaid(req.body.payload.payment.entity.order_id);
  res.json({ ok: true });
}
`,
  "src/payments/service.ts": `import { db } from "../db/client";
import type { Payment } from "../db/models";

export class PaymentService {
  async createOrder(amount: number, currency = "INR"): Promise<Payment> {
    return db.insert("payments", { amount, currency, status: "created" });
  }

  async markPaid(orderId: string): Promise<void> {
    await db.update("payments", { orderId }, { status: "paid" });
  }

  async retryPayment(orderId: string, attempts = 3): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      const p = await db.find<Payment>("payments", { orderId });
      if (p?.status === "paid") return true;
      await new Promise((r) => setTimeout(r, 2 ** i * 100));
    }
    return false;
  }

  async refund(orderId: string): Promise<void> {
    await db.update("payments", { orderId }, { status: "refunded" });
  }
}
`,
  "src/orders/create.ts": `import type { Request, Response } from "express";
import { PaymentService } from "../payments/service";
import { verifyOrderSignature } from "../payments/verify";

const payments = new PaymentService();

export async function createOrderHandler(req: Request, res: Response) {
  const { amount, razorpay_signature, razorpay_payment_id, order_id } = req.body;
  if (razorpay_signature && !verifyOrderSignature(order_id, razorpay_payment_id, razorpay_signature, process.env.RAZORPAY_KEY_SECRET!)) {
    return res.status(400).json({ error: "bad signature" });
  }
  const order = await payments.createOrder(amount);
  res.json(order);
}
`,
  "src/auth/token.ts": `import { createHmac } from "node:crypto";

export const TOKEN_TTL_HOURS = 24;

export function createToken(userId: string, now = Date.now()): string {
  const exp = now + TOKEN_TTL_HOURS * 3600_000;
  const body = \`\${userId}.\${exp}\`;
  return \`\${body}.\${sign(body)}\`;
}

export function validateToken(token: string, now = Date.now()): boolean {
  const [userId, exp, sig] = token.split(".");
  if (!userId || !exp || sign(\`\${userId}.\${exp}\`) !== sig) return false;
  return Number(exp) > now;
}

function sign(s: string): string {
  return createHmac("sha256", process.env.TOKEN_SECRET ?? "dev").update(s).digest("hex").slice(0, 32);
}
`,
  "src/auth/session.ts": `import type { Request, Response } from "express";
import { createToken, validateToken } from "./token";

export interface Session {
  userId: string;
  token: string;
  expiresAt: number;
}

export function refreshSession(session: Session, now = Date.now()): Session {
  if (!validateToken(session.token, now)) throw new Error("session expired");
  const token = createToken(session.userId, now);
  return { ...session, token, expiresAt: now + 6 * 3600_000 };
}

export function refreshSessionHandler(req: Request, res: Response) {
  res.json(refreshSession(req.body.session));
}
`,
  "src/db/client.ts": `export const db = {
  async insert(table: string, row: any): Promise<any> { return { id: "1", ...row, table }; },
  async update(table: string, where: any, patch: any): Promise<void> { void table; void where; void patch; },
  async find<T>(table: string, where: any): Promise<T | null> { void table; void where; return null; },
};
`,
  "src/db/models.ts": `export interface Payment {
  id: string;
  orderId?: string;
  amount: number;
  currency: string;
  status: "created" | "paid" | "refunded";
}

export interface User {
  id: string;
  email: string;
}
`,
  "src/utils/time.ts": `export function nowUtc(): number {
  return Date.now();
}

export function toLocal(ts: number, tz: string): string {
  return new Date(ts).toLocaleString("en-IN", { timeZone: tz });
}
`,
  "tests/payments/verify.test.ts": `import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyPaymentSignature } from "../../src/payments/verify";

describe("verifyPaymentSignature", () => {
  it("accepts a valid signature over the raw body", () => {
    const body = '{"a":1}';
    const sig = createHmac("sha256", "s").update(body).digest("hex");
    expect(verifyPaymentSignature(body, sig, "s")).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyPaymentSignature('{"a":2}', "00", "s")).toBe(false);
  });
});
`,
  "tests/auth/session.test.ts": `import { describe, it, expect } from "vitest";
import { refreshSession } from "@/auth/session";
import { createToken } from "@/auth/token";

describe("refreshSession", () => {
  it("extends expiry for a valid token", () => {
    const s = refreshSession({ userId: "u", token: createToken("u"), expiresAt: 0 });
    expect(s.expiresAt).toBeGreaterThan(Date.now());
  });
});
`,
};

// Unrelated feature modules, so the relevant code is a needle in a haystack.
const FEATURES = ["inventory", "shipping", "notifications", "analytics", "catalog", "reviews", "coupons", "search", "wishlist", "reports"];
const PARTS = ["controller", "service", "repository", "validators", "mapper"];
function filler(feature, part) {
  const Cap = feature[0].toUpperCase() + feature.slice(1);
  const PartCap = part[0].toUpperCase() + part.slice(1);
  const lines = [`import { db } from "../../db/client";`, "", `export class ${Cap}${PartCap} {`];
  for (const verb of ["list", "get", "create", "update", "remove", "sync"]) {
    lines.push(`  async ${verb}${Cap}(id: string, input: Record<string, unknown> = {}) {`);
    lines.push(`    // ${verb} ${feature} records via the ${part}`);
    lines.push(`    const row = await db.find("${feature}", { id });`);
    lines.push(`    if (!row) return db.insert("${feature}", { id, ...input });`);
    lines.push(`    await db.update("${feature}", { id }, input);`);
    lines.push(`    return row;`);
    lines.push(`  }`, "");
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

export function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "nb-fixture-"));
  const write = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();
  git("init", "-q");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "fixture");
  git("config", "commit.gpgsign", "false");
  write(".gitignore", ".env\nnode_modules/\n");
  for (const [rel, content] of Object.entries(FILES)) write(rel, content);
  for (const f of FEATURES) for (const p of PARTS) write(`src/features/${f}/${p}.ts`, filler(f, p));
  git("add", "-A");
  git("commit", "-qm", "Initial shop API");
  // History: a regression-shaped change to webhook handling, and a TTL change.
  write("src/payments/callback.ts", FILES["src/payments/callback.ts"].replace("// Re-serialising", "// NOTE: parsed body used for verification\n  // Re-serialising"));
  git("add", "-A");
  git("commit", "-qm", "Parse webhook JSON body before signature verification in payment callback");
  write("src/auth/token.ts", FILES["src/auth/token.ts"].replace("TOKEN_TTL_HOURS = 24", "TOKEN_TTL_HOURS = 6"));
  git("add", "-A");
  git("commit", "-qm", "Shorten auth token TTL from 24h to 6h");
  write("src/features/shipping/service.ts", filler("shipping", "service").replace("return row;", "return { ...row, carrier: 'bluedart' };"));
  git("add", "-A");
  git("commit", "-qm", "Return carrier from shipping service updates");
  return root;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(makeFixture());
