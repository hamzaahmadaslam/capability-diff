// Parsing PHP and walking its syntax tree. Nothing here runs the code.
import { Engine } from "php-parser";

const engine = new Engine({
  parser: { php8: true, suppressErrors: true },
  ast: { withPositions: true },
});

/** Parses one file. A file that cannot be parsed at all returns null and is reported, never thrown. */
export function parsePhp(code, file) {
  try {
    return engine.parseCode(code, file);
  } catch {
    return null;
  }
}

/** Visits every node depth first. `visit(node, ancestors)` sees the chain from the root, nearest last. */
export function walk(root, visit) {
  const ancestors = [];
  const step = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) step(child);
      return;
    }
    if (typeof node.kind !== "string") return;
    visit(node, ancestors);
    ancestors.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
      if (value && typeof value === "object") step(value);
    }
    ancestors.pop();
  };
  step(root);
}

/** The source text of a node, from its offsets. */
export function sourceOf(code, node) {
  const start = node?.loc?.start?.offset;
  const end = node?.loc?.end?.offset;
  return start === undefined || end === undefined ? "" : code.slice(start, end);
}

/** A called function's plain name ("do_action" for `do_action()` and `\do_action()`), or null. */
export function calledName(node) {
  if (node?.kind !== "call" || node.what?.kind !== "name") return null;
  return String(node.what.name).replace(/^\\/, "").toLowerCase();
}

/**
 * A hook name as the code writes it. Literal strings give the name itself; anything computed becomes a
 * placeholder: `"x_{$type}"` gives `x_{$type}`, `'x_' . $type` the same, `'x_' . get_type()` gives `x_{get_type()}`.
 * `pattern` replaces every placeholder with `{*}`, so renaming a variable does not look like a new hook.
 */
export function hookName(node, code) {
  const parts = [];
  let dynamic = false;
  const add = (expr) => {
    if (!expr) return;
    if (expr.kind === "string") parts.push(expr.value);
    else if (expr.kind === "encapsed") for (const part of expr.value) add(part.expression);
    else if (expr.kind === "bin" && expr.type === ".") {
      add(expr.left);
      add(expr.right);
    } else if (expr.kind === "variable" && typeof expr.name === "string") {
      dynamic = true;
      parts.push(`{$${expr.name}}`);
    } else {
      dynamic = true;
      parts.push(`{${sourceOf(code, expr).replace(/\s+/g, " ").trim() || "…"}}`);
    }
  };
  add(node);
  const name = parts.join("");
  return { name, dynamic, pattern: name.replace(/\{[^}]*\}/g, "{*}") };
}
