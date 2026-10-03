/** Term extraction shared by the indexer (code) and the task parser (natural language). */

const STOP = new Set(
  `a an and are as at be but by can do does for from has have how i if in into is it its of on or so that the their then there these this to was we were what when where which while who why will with would you your should could must not no yes
  const let var function return import export default true false null undefined new async await else case break continue switch try catch finally throw typeof instanceof void any unknown never string number boolean object symbol bigint
  interface type class extends implements public private protected static readonly get set of require module exports props args arg res req ctx cb fn val tmp obj arr idx el e i j k x y z id ids
  fix bug issue make add update change use using used please now also after before some any all need needs want`.split(/\s+/),
);

export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+|(?<=[a-zA-Z])(?=[0-9])|(?<=[0-9])(?=[a-zA-Z])/)
    .filter(Boolean);
}

export function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed") && !w.endsWith("eed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

export function normTerm(w: string): string | null {
  const lw = w.toLowerCase();
  if (lw.length < 2 || lw.length > 40 || STOP.has(lw) || /^\d+$/.test(lw)) return null;
  return stem(lw);
}

/** Terms from arbitrary text: identifiers are split on case/underscore boundaries. */
export function termsOf(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
    const parts = splitIdentifier(raw);
    for (const p of parts) {
      const t = normTerm(p);
      if (t) out.push(t);
    }
    // Keep the whole compound identifier too (lowercased) so exact multi-part names score higher.
    if (parts.length > 1) {
      const whole = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (whole.length >= 4 && whole.length <= 60) out.push(whole);
    }
  }
  return out;
}

export function termFreq(text: string, into = new Map<string, number>()): Map<string, number> {
  for (const t of termsOf(text)) into.set(t, (into.get(t) ?? 0) + 1);
  return into;
}
