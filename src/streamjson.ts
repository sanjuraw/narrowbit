/** Shared parser for `claude -p --output-format stream-json` output: usage, turns, cost, tool calls. Used by bench.ts and providers/claude-cli.ts. */
export function parseStream(jsonl: string) {
  const toolCalls: Record<string, number> = {};
  const readFiles = new Set<string>();
  let result: any = null;
  const perMsg = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
  const seenMsg = new Set<string>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "assistant" && ev.message) {
      const m = ev.message;
      for (const c of m.content ?? []) {
        if (c.type !== "tool_use") continue;
        toolCalls[c.name] = (toolCalls[c.name] ?? 0) + 1;
        if (c.name === "Read" && c.input?.file_path) readFiles.add(String(c.input.file_path));
      }
      // Streamed assistant events repeat per content block with the same message id; count usage once.
      if (m.usage && m.id && !seenMsg.has(m.id)) {
        seenMsg.add(m.id);
        perMsg.input += m.usage.input_tokens ?? 0;
        perMsg.cacheCreate += m.usage.cache_creation_input_tokens ?? 0;
        perMsg.cacheRead += m.usage.cache_read_input_tokens ?? 0;
        perMsg.output += m.usage.output_tokens ?? 0;
      }
    }
    if (ev.type === "result") result = ev;
  }
  const u = result?.usage;
  const usage = u
    ? { input: u.input_tokens ?? 0, cacheCreate: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 }
    : perMsg;
  // Prefer whichever accounting is larger: result.usage may exclude subagent/tool-internal calls in some versions.
  const pick = (a: number, b: number) => Math.max(a, b);
  return {
    toolCalls,
    filesRead: readFiles.size,
    turns: result?.num_turns ?? 0,
    durationMs: result?.duration_ms ?? 0,
    costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
    isError: !!result?.is_error || !result,
    /** The result event's own text when it is an error (e.g. "You've hit your session limit · resets 1am"). */
    errorText: result?.is_error ? String(result.result ?? "") : "",
    usage: {
      input: pick(usage.input, perMsg.input),
      cacheCreate: pick(usage.cacheCreate, perMsg.cacheCreate),
      cacheRead: pick(usage.cacheRead, perMsg.cacheRead),
      output: pick(usage.output, perMsg.output),
    },
  };
}

/** Concatenated assistant text content from a stream-json transcript (ignores tool_use blocks). */
export function extractText(jsonl: string): string {
  let text = "";
  let structured: string | undefined;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "assistant" && ev.message?.content) {
      for (const c of ev.message.content) if (c.type === "text") text += c.text;
    }
    // A call made with --json-schema answers through a tool call; the validated object is on the result line.
    if (ev.type === "result" && ev.structured_output !== undefined && ev.structured_output !== null) structured = JSON.stringify(ev.structured_output);
  }
  return structured ?? text.trim();
}
