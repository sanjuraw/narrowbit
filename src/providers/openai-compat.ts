import type { ModelCallOptions, ModelCallResult } from "./claude-cli.js";
import { PROVIDER_INFO, type Endpoint } from "./models.js";
import { promptWithFiles, readAttachment } from "../attachments.js";

/**
 * Model adapter for every API and local provider (OpenRouter, Groq, Gemini, OpenAI, DeepSeek,
 * Ollama, LM Studio, any custom server): all speak the OpenAI-compatible /chat/completions API.
 * Same contract as claude-cli.ts, so runtime.ts drives it unchanged — including sessions: an HTTP
 * API has no server-side session, so the conversation is kept here, per `sessionId`, and resent
 * each turn (providers that cache prompts, e.g. OpenAI and DeepSeek, discount the repeated prefix
 * automatically). Compaction in runtime.ts retires a session and starts a fresh one, which is what
 * keeps this history bounded.
 *
 * `costUsd` is cumulative per session, matching claude-cli.ts (runtime.ts logs deltas). Only
 * OpenRouter reports a real per-call cost; elsewhere it stays 0 — local models are free, and
 * direct APIs bill on their own dashboards, so tokens are the comparable number there.
 */
type Message = { role: "system" | "user" | "assistant"; content: string | unknown[] };

const sessions = new Map<string, { messages: Message[]; costUsd: number }>();

/** Whether a session's conversation is still held in this process (a follow-up can resume it). */
export function hasSession(id: string): boolean {
  return sessions.has(id);
}

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("");
  return "";
}

export async function callOpenAICompat(ep: Endpoint, opts: ModelCallOptions): Promise<ModelCallResult> {
  const fail = (errorMessage: string, fatal: boolean): ModelCallResult => ({
    text: "",
    usage: { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 },
    costUsd: null,
    turns: 0,
    isError: true,
    errorMessage,
    fatal,
  });
  const label = PROVIDER_INFO[ep.provider].label;
  if (!opts.model) return fail(`no ${label} model chosen`, true);
  if (ep.needsKey && !ep.apiKey) return fail(`${label} needs an API key (narrowbit keys set ${ep.provider})`, true);

  const id = opts.sessionId ?? "";
  let session = id && opts.resume ? sessions.get(id) : undefined;
  if (!session) {
    session = { messages: opts.systemPrompt ? [{ role: "system", content: opts.systemPrompt }] : [], costUsd: 0 };
    if (id) sessions.set(id, session);
  }
  // Images go as image_url parts on this turn's message; PDFs are turned into text. Later turns resend the conversation
  // with the image replaced by a short marker, so it is paid for once.
  const shown = promptWithFiles(opts.prompt, opts.attachments, { images: true, pdfs: false });
  const imgs = (opts.attachments ?? []).map(readAttachment).filter((f): f is NonNullable<ReturnType<typeof readAttachment>> => !!f && f.kind === "image");
  const userContent: string | unknown[] = imgs.length ? [{ type: "text", text: shown }, ...imgs.map((f) => ({ type: "image_url", image_url: { url: `data:${f.mime};base64,${f.base64}` } }))] : shown;
  const messages = [...session.messages, { role: "user" as const, content: userContent }];

  const body: Record<string, unknown> = { model: opts.model, messages, max_tokens: 8192 };
  if (ep.provider === "openrouter") body.usage = { include: true };
  if (opts.jsonObject) body.response_format = { type: "json_object" };
  // DeepSeek V4 thinks by default at "high" effort, and its reasoning counts as output tokens — the priciest kind
  // (74% of the bill in our Hono runs). Map Narrowbit's effort levels onto its two controls.
  if (ep.provider === "deepseek" && opts.effort) {
    // "medium" is Narrowbit's default and is left to DeepSeek's own default (thinking on, high effort): on 20 Hono
    // tasks that scored 20/20, against 19/20 for reasoning-low and 18/20 with thinking off.
    if (opts.effort === "low") body.thinking = { type: "disabled" };
    else if (opts.effort === "high") body.reasoning_effort = "high";
    else if (opts.effort === "xhigh" || opts.effort === "max") body.reasoning_effort = "max";
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ep.apiKey) headers.authorization = `Bearer ${ep.apiKey}`;
  if (ep.provider === "openrouter") headers["x-title"] = "Narrowbit";

  let res: Response;
  try {
    res = await fetch(`${ep.baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000) });
  } catch (e: any) {
    if (e?.name === "TimeoutError") return fail(`${label} timed out`, false);
    const code = e?.cause?.code ?? e?.name ?? "network error";
    const local = PROVIDER_INFO[ep.provider].kind === "local";
    // A local server that isn't running won't start on a retry; a hosted API blip might recover.
    return fail(`couldn't reach ${label} at ${ep.baseUrl} (${code})${local ? ` — is ${label} running?` : ""}`, local && code === "ECONNREFUSED");
  }
  // The body can fail after the headers arrived (a connection reset, the timeout firing mid-download): that is a
  // provider error like any other, so it must come back through fail() and reach the runtime's retry/fallback.
  let raw: string;
  try {
    raw = await res.text();
  } catch (e: any) {
    if (e?.name === "TimeoutError") return fail(`${label} timed out`, false);
    return fail(`the connection to ${label} broke while its reply was coming in (${e?.cause?.code ?? e?.name ?? "network error"})`, false);
  }
  let d: any = null;
  try {
    d = JSON.parse(raw);
  } catch {
    // leave null; handled below
  }
  if (!res.ok) {
    const msg = String(d?.error?.message ?? d?.error ?? d?.message ?? raw).slice(0, 300);
    if (res.status === 429) {
      // Rate limited (common on free tiers): wait before runtime.ts retries the identical call.
      const wait = Math.min(Number(res.headers.get("retry-after")) || 10, 30);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return fail(`${label} rate limit: ${msg}`, false);
    }
    // Bad key, unknown model, bad request: retrying the same call won't help.
    return fail(`${label} ${res.status}: ${msg}`, res.status < 500);
  }
  const text = contentText(d?.choices?.[0]?.message?.content);
  if (!text) return fail(`${label} returned no text${d?.choices?.[0]?.finish_reason ? ` (finish_reason ${d.choices[0].finish_reason})` : ""}`, false);

  const u = d.usage ?? {};
  const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0);
  const prompt = Number(u.prompt_tokens ?? 0);
  session.messages = [...messages.slice(0, -1), { role: "user", content: imgs.length ? `${shown}\n[${imgs.length} image(s) were attached to this message]` : shown }, { role: "assistant", content: text }];
  session.costUsd += Number(u.cost ?? 0) || 0;
  return {
    text,
    usage: { input: Math.max(0, prompt - cached), cacheCreate: 0, cacheRead: cached, output: Number(u.completion_tokens ?? 0) },
    reasoningTokens: Number(u.completion_tokens_details?.reasoning_tokens ?? 0) || undefined,
    costUsd: session.costUsd,
    turns: 1,
    isError: false,
    fatal: false,
  };
}
