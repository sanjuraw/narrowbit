import ts from "typescript";
import { termFreq } from "./terms.js";

export interface ParsedSymbol {
  name: string;
  /** e.g. `PaymentService.retryPayment` */
  qualified: string;
  kind: "function" | "class" | "method" | "interface" | "type" | "enum" | "variable" | "route" | "test" | "suite";
  startLine: number;
  endLine: number;
  exported: boolean;
  signature: string;
  doc: string;
  /** Identifier names referenced inside the symbol body (deduped, capped). */
  refs: string[];
}

export interface ParsedImport {
  spec: string;
  kind: "import" | "reexport" | "require" | "dynamic";
  typeOnly: boolean;
  /** imported (exported name in target, "default", "*") → local name */
  bindings: { imported: string; local: string }[];
}

export interface ParsedFile {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  terms: Map<string, number>;
  lineCount: number;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "options", "head"]);
const TEST_FNS = new Set(["it", "test"]);
const SUITE_FNS = new Set(["describe", "suite", "context"]);

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasExport(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function firstDocLine(node: ts.Node, sf: ts.SourceFile): string {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  const last = ranges[ranges.length - 1];
  if (!last) return "";
  const txt = sf.text.slice(last.pos, last.end);
  const line = txt
    .replace(/^\/\*\*?|\*\/$/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?|^\s*\/\/\s?/, "").trim())
    .find((l) => l && !l.startsWith("@"));
  return (line ?? "").slice(0, 160);
}

function signatureOf(node: ts.Node, sf: ts.SourceFile): string {
  const text = node.getText(sf);
  const start = node.getStart(sf);
  let cut = text.length;
  // Stop at the body so the signature is declaration-only.
  let fn: ts.Node | undefined = node;
  if (ts.isVariableDeclaration(node)) fn = node.initializer;
  if (fn && ts.isFunctionLike(fn) && (fn as ts.FunctionLikeDeclaration).body) {
    cut = (fn as ts.FunctionLikeDeclaration).body!.getStart(sf) - start;
  } else if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
    cut = text.indexOf("{");
  } else if (ts.isVariableDeclaration(node) && node.initializer) {
    cut = Math.min(text.length, node.initializer.getStart(sf) - start + 80);
  }
  let sig = text.slice(0, cut > 0 ? cut : text.length);
  sig = sig.replace(/\s+/g, " ").trim().replace(/[{=]\s*$/, "").trim();
  return sig.length > 220 ? sig.slice(0, 217) + "..." : sig;
}

function collectRefs(node: ts.Node, exclude: string): string[] {
  const seen = new Set<string>();
  const visit = (n: ts.Node) => {
    if (seen.size >= 200) return;
    if (ts.isIdentifier(n)) {
      const t = n.text;
      if (t !== exclude && t.length > 1) seen.add(t);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return [...seen];
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function stringArg(call: ts.CallExpression): string | null {
  const a = call.arguments[0];
  if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) return a.text;
  if (a && ts.isTemplateExpression(a)) return a.head.text + "…";
  return null;
}

function calleeName(expr: ts.Expression): { base: string; prop?: string } | null {
  if (ts.isIdentifier(expr)) return { base: expr.text };
  if (ts.isPropertyAccessExpression(expr)) {
    const inner = calleeName(expr.expression);
    if (inner) return { base: inner.base, prop: expr.name.text };
    return { base: "", prop: expr.name.text };
  }
  return null;
}

export function parseSource(path: string, text: string): ParsedFile {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];

  const push = (node: ts.Node, name: string, qualified: string, kind: ParsedSymbol["kind"], exported: boolean, sigNode: ts.Node = node) => {
    symbols.push({
      name,
      qualified,
      kind,
      startLine: lineOf(sf, node.getStart(sf)),
      endLine: lineOf(sf, node.getEnd()),
      exported,
      signature: signatureOf(sigNode, sf),
      doc: firstDocLine(node, sf),
      refs: collectRefs(node, name),
    });
  };

  const addClassMembers = (cls: ts.ClassLikeDeclaration, clsName: string, exported: boolean) => {
    for (const m of cls.members) {
      let mname: string | null = null;
      if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.name) mname = m.name.getText(sf);
      else if (ts.isConstructorDeclaration(m)) mname = "constructor";
      else if (ts.isPropertyDeclaration(m) && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer)))
        mname = m.name.getText(sf);
      if (!mname) continue;
      push(m, mname, `${clsName}.${mname}`, "method", exported);
    }
  };

  for (const st of sf.statements) {
    const exported = hasExport(st);
    if (ts.isFunctionDeclaration(st)) {
      const name = st.name?.text ?? "default";
      push(st, name, name, "function", exported);
    } else if (ts.isClassDeclaration(st)) {
      const name = st.name?.text ?? "default";
      push(st, name, name, "class", exported);
      addClassMembers(st, name, exported);
    } else if (ts.isInterfaceDeclaration(st)) {
      push(st, st.name.text, st.name.text, "interface", exported);
    } else if (ts.isTypeAliasDeclaration(st)) {
      push(st, st.name.text, st.name.text, "type", exported);
    } else if (ts.isEnumDeclaration(st)) {
      push(st, st.name.text, st.name.text, "enum", exported);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const init = d.initializer;
        const isFn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        const node = st.declarationList.declarations.length === 1 ? st : d;
        push(node, d.name.text, d.name.text, isFn ? "function" : "variable", exported, d);
        if (init && ts.isClassExpression(init)) addClassMembers(init, d.name.text, exported);
      }
    } else if (ts.isExportAssignment(st)) {
      const e = st.expression;
      if (ts.isIdentifier(e)) continue; // `export default foo` — foo is indexed already
      push(st, "default", "default", ts.isArrowFunction(e) || ts.isFunctionExpression(e) ? "function" : "variable", true);
    } else if (ts.isModuleDeclaration(st) && st.name && ts.isIdentifier(st.name)) {
      push(st, st.name.text, st.name.text, "variable", exported);
    }

    // Imports / re-exports
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const bindings: ParsedImport["bindings"] = [];
      const clause = st.importClause;
      if (clause?.name) bindings.push({ imported: "default", local: clause.name.text });
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bindings.push({ imported: "*", local: nb.name.text });
      if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements) bindings.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text });
      imports.push({ spec: st.moduleSpecifier.text, kind: "import", typeOnly: !!clause?.isTypeOnly, bindings });
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const bindings: ParsedImport["bindings"] = [];
      if (st.exportClause && ts.isNamedExports(st.exportClause))
        for (const el of st.exportClause.elements) bindings.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text });
      else bindings.push({ imported: "*", local: "*" });
      imports.push({ spec: st.moduleSpecifier.text, kind: "reexport", typeOnly: st.isTypeOnly, bindings });
    } else if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference)) {
      const ex = st.moduleReference.expression;
      if (ts.isStringLiteral(ex)) imports.push({ spec: ex.text, kind: "require", typeOnly: false, bindings: [{ imported: "*", local: st.name.text }] });
    }
  }

  // Whole-tree walk: require()/import(), routes, test cases.
  const suiteStack: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = calleeName(n.expression);
      const arg = stringArg(n);
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword && arg) {
        imports.push({ spec: arg, kind: "dynamic", typeOnly: false, bindings: [] });
      } else if (callee?.base === "require" && !callee.prop && arg) {
        const bindings: ParsedImport["bindings"] = [];
        const parent = n.parent;
        if (parent && ts.isVariableDeclaration(parent)) {
          if (ts.isIdentifier(parent.name)) bindings.push({ imported: "*", local: parent.name.text });
          else if (ts.isObjectBindingPattern(parent.name))
            for (const el of parent.name.elements)
              if (ts.isIdentifier(el.name)) bindings.push({ imported: el.propertyName?.getText(sf) ?? el.name.text, local: el.name.text });
        }
        imports.push({ spec: arg, kind: "require", typeOnly: false, bindings });
      } else if (callee && arg !== null) {
        const fn = callee.prop && ["only", "skip", "each", "todo", "concurrent"].includes(callee.prop) ? callee.base : callee.prop ?? callee.base;
        if (callee.prop && HTTP_METHODS.has(callee.prop) && arg.startsWith("/")) {
          const name = `${callee.prop.toUpperCase()} ${arg}`;
          push(n, name, name, "route", false, n);
          symbols[symbols.length - 1].signature = `${callee.base}.${callee.prop}(${JSON.stringify(arg)}, …)`;
        } else if (SUITE_FNS.has(fn) || TEST_FNS.has(fn)) {
          const isSuite = SUITE_FNS.has(fn);
          const q = [...suiteStack, arg].join(" > ");
          push(n, arg, q, isSuite ? "suite" : "test", false, n);
          symbols[symbols.length - 1].signature = `${fn}(${JSON.stringify(arg)})`;
          if (isSuite) {
            suiteStack.push(arg);
            ts.forEachChild(n, walk);
            suiteStack.pop();
            return;
          }
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);

  // Terms: identifiers + string literals + comments, all through the same splitter.
  const terms = termFreq(text.length > 400_000 ? text.slice(0, 400_000) : text);
  return { symbols, imports, terms, lineCount: sf.getLineStarts().length };
}
