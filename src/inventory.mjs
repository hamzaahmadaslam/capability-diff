// Every operation a codebase exposes (AJAX actions, admin-post actions, REST routes, admin pages) and the
// authorization in front of each: capability checks, nonce checks, and where the first write happens.
import { capInfo } from "./caps.mjs";
import { calledName, hookName, parsePhp, sourceOf } from "./php.mjs";

const CHECKS = {
  current_user_can: 0,
  user_can: 1,
  current_user_can_for_site: 1,
  current_user_can_for_blog: 1,
};
const NONCES = { check_ajax_referer: 0, check_admin_referer: 0, wp_verify_nonce: 1 };
const WRITES = new Set(
  `update_option add_option delete_option update_site_option add_site_option delete_site_option
   update_post_meta add_post_meta delete_post_meta update_user_meta add_user_meta delete_user_meta
   update_term_meta add_term_meta delete_term_meta update_comment_meta add_comment_meta delete_comment_meta
   update_metadata add_metadata delete_metadata wp_insert_post wp_update_post wp_delete_post wp_trash_post
   wp_insert_attachment wp_delete_attachment wp_insert_user wp_update_user wp_delete_user wp_create_user
   wp_set_password wp_set_object_terms wp_set_post_terms wp_insert_term wp_update_term wp_delete_term
   wp_insert_comment wp_update_comment wp_delete_comment wp_set_comment_status set_theme_mod remove_theme_mod
   switch_theme activate_plugin activate_plugins deactivate_plugins delete_plugins file_put_contents unlink
   move_uploaded_file wp_handle_upload media_handle_upload media_handle_sideload set_transient delete_transient
   set_site_transient delete_site_transient wp_schedule_event wp_schedule_single_event`
    .split(/\s+/)
    .filter(Boolean),
);
const WPDB_WRITES = new Set(["insert", "update", "delete", "replace", "query"]);
const MENUS = {
  add_menu_page: [2, 3],
  add_submenu_page: [3, 4],
  add_options_page: [2, 3],
  add_management_page: [2, 3],
  add_theme_page: [2, 3],
  add_plugins_page: [2, 3],
  add_users_page: [2, 3],
  add_dashboard_page: [2, 3],
  add_posts_page: [2, 3],
  add_media_page: [2, 3],
  add_links_page: [2, 3],
  add_pages_page: [2, 3],
  add_comments_page: [2, 3],
};
const REST_METHODS = {
  READABLE: "GET",
  CREATABLE: "POST",
  EDITABLE: "POST,PUT,PATCH",
  DELETABLE: "DELETE",
  ALLMETHODS: "GET,POST,PUT,PATCH,DELETE",
};
const SKIP_BODY = new Set(["closure", "arrowfunc", "function", "class", "trait", "interface", "enum"]);
const MAX_DEPTH = 4;
const SNIPPET = 240;

const lower = (s) => String(s ?? "").toLowerCase();
const shortName = (name) => lower(String(name).replace(/^.*\\/, ""));
const identName = (node) => (typeof node === "string" ? node : typeof node?.name === "string" ? node.name : null);
const squash = (text) => text.replace(/\s+/g, " ").trim();
const clip = (text) => (text.length > SNIPPET ? `${text.slice(0, SNIPPET - 1)}…` : text);

/** Classes and functions by short, lower-cased name, so callbacks and calls can be followed. */
function declarations(parsed) {
  const functions = new Map();
  const classes = new Map();
  const methodsByName = new Map();
  for (const { path, code, ast } of parsed) {
    const visit = (nodes) => {
      for (const node of nodes ?? []) {
        if (!node || typeof node !== "object") continue;
        if (node.kind === "namespace" || node.kind === "block") visit(node.children);
        else if (node.kind === "if") {
          visit(node.body?.children ?? [node.body]);
          if (node.alternate) visit(node.alternate.children ?? [node.alternate]);
        } else if (node.kind === "function" && identName(node.name)) {
          const list = functions.get(lower(identName(node.name))) ?? [];
          list.push({ path, code, node });
          functions.set(lower(identName(node.name)), list);
        } else if (["class", "trait"].includes(node.kind) && identName(node.name)) {
          const name = lower(identName(node.name));
          const methods = new Map();
          for (const member of node.body ?? []) {
            if (member.kind !== "method") continue;
            const decl = { path, code, node: member, className: name };
            methods.set(lower(identName(member.name)), decl);
            const byName = methodsByName.get(lower(identName(member.name))) ?? [];
            byName.push(decl);
            methodsByName.set(lower(identName(member.name)), byName);
          }
          const traits = (node.body ?? []).filter((m) => m.kind === "traituse").flatMap((m) => m.traits.map((t) => shortName(t.name)));
          if (!classes.has(name)) classes.set(name, { path, node, methods, parent: node.extends ? shortName(node.extends.name) : null, traits });
        }
      }
    };
    visit(ast.children);
  }
  return { functions, classes, methodsByName };
}

/** A method of a class in the codebase, looking through its traits and parent classes. */
function findMethod(decls, className, method) {
  let current = className;
  for (let hops = 0; current && hops < 10; hops++) {
    const cls = decls.classes.get(current);
    if (!cls) return null;
    const own = cls.methods.get(lower(method));
    if (own) return own;
    for (const trait of cls.traits) {
      const found = decls.classes.get(trait)?.methods.get(lower(method));
      if (found) return found;
    }
    current = cls.parent;
  }
  return null;
}

/** The class a callable or call names: `$this`, `self`, `static`, `__CLASS__`, `Foo::class`, 'Foo'. */
function classOf(node, ctx) {
  if (!node) return null;
  if (node.kind === "variable" && node.name === "this") return ctx.className;
  if (["selfreference", "staticreference"].includes(node.kind)) return ctx.className;
  if (node.kind === "parentreference") return ctx.className ? ctx.decls.classes.get(ctx.className)?.parent ?? null : null;
  if (node.kind === "magic" && node.value === "__CLASS__") return ctx.className;
  if (node.kind === "string") return shortName(node.value);
  if (node.kind === "name") {
    const raw = lower(node.name);
    return raw === "self" || raw === "static" ? ctx.className : shortName(node.name);
  }
  if (node.kind === "staticlookup" && lower(identName(node.offset)) === "class") return classOf(node.what, ctx);
  return null;
}

/** A string callable's text when it is built from literals and __NAMESPACE__ (`__NAMESPACE__ . '\\fn'`). */
function literalText(node) {
  if (!node) return null;
  if (node.kind === "string") return node.value;
  if (node.kind === "magic" && node.value === "__NAMESPACE__") return "";
  if (node.kind === "bin" && node.type === ".") {
    const left = literalText(node.left);
    const right = literalText(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

/**
 * What a callback points at: { body, path, code, className, label } for code in the codebase, { builtin } for a
 * WordPress function such as __return_true, or null when it cannot be followed statically.
 */
function resolveCallable(node, ctx) {
  if (!node) return null;
  if (node.kind === "closure" || node.kind === "arrowfunc") {
    return { body: node.body, path: ctx.path, code: ctx.code, className: ctx.className, label: `${node.kind === "closure" ? "function" : "fn"} at ${ctx.path}:${node.loc.start.line}` };
  }
  const text = literalText(node);
  if (text !== null) {
    if (text.includes("::")) {
      const [cls, method] = text.split("::");
      const found = findMethod(ctx.decls, shortName(cls), method);
      return found ? fromMethod(found, `${cls}::${method}`) : null;
    }
    const name = shortName(text);
    const found = ctx.decls.functions.get(name);
    if (found?.length) return { body: found[0].node.body, path: found[0].path, code: found[0].code, className: null, label: `${text.replace(/^\\/, "")}()` };
    return { builtin: name };
  }
  if (node.kind === "array" && node.items?.length === 2) {
    const [target, method] = node.items.map((item) => item?.value ?? item);
    const methodName = literalText(method);
    if (methodName === null) return null;
    const cls = classOf(target, ctx);
    if (cls) {
      const found = findMethod(ctx.decls, cls, methodName);
      return found ? fromMethod(found, `${found.className}::${methodName}()`) : null;
    }
    // An object held in a variable: follow it when only one class in the codebase has a method of that name.
    const candidates = ctx.decls.methodsByName.get(lower(methodName)) ?? [];
    return candidates.length === 1 ? fromMethod(candidates[0], `${candidates[0].className}::${methodName}()`) : null;
  }
  return null;
}

const fromMethod = (decl, label) => ({ body: decl.node.body, path: decl.path, code: decl.code, className: decl.className, label });

/** The text of the condition a check sits in: the `if` test around it, or the statement that holds it. */
function conditionOf(stack, code) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const { node, key } = stack[i];
    if ((node.kind === "if" || node.kind === "while" || node.kind === "retif") && key === "test") return clip(squash(sourceOf(code, node.test)));
    if (["expressionstatement", "return", "echo"].includes(node.kind)) return clip(squash(sourceOf(code, node)));
  }
  return "";
}

/**
 * Walks a handler in source order, following calls into the codebase's own functions and methods, and returns
 * the events met on the way: capability checks, nonce checks and writes, each with a sequence number.
 */
export function analyze(start, decls) {
  const events = [];
  const seen = new Set();
  let seq = 0;

  const run = (target, depth, via) => {
    if (!target?.body || depth > MAX_DEPTH) return;
    const key = `${target.path}:${target.body.loc?.start?.offset}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ctx = { decls, className: target.className, path: target.path, code: target.code };
    const at = (node) => `${target.path}:${node.loc?.start?.line ?? 0}`;
    const snippet = (node) => clip(squash(sourceOf(target.code, node)).replace(/;$/, ""));

    const visit = (node, stack) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach((child) => visit(child, stack));
      if (typeof node.kind !== "string") return;
      if (SKIP_BODY.has(node.kind) && stack.length) return;
      if (node.kind === "call") {
        onCall(node, stack);
      }
      for (const [prop, value] of Object.entries(node)) {
        if (prop === "loc" || prop === "leadingComments" || prop === "trailingComments") continue;
        if (value && typeof value === "object") visit(value, [...stack, { node, key: prop }]);
      }
    };

    const onCall = (node, stack) => {
      const name = calledName(node);
      const args = node.arguments ?? [];
      if (name && name in CHECKS) {
        const capNode = args[CHECKS[name]];
        const cap = capNode?.kind === "string" ? capNode.value : null;
        events.push({
          type: "check",
          fn: name,
          cap: cap ?? squash(sourceOf(target.code, capNode ?? node)),
          dynamic: cap === null,
          objectArgs: Math.max(0, args.length - CHECKS[name] - 1),
          ...capInfo(cap),
          condition: conditionOf(stack, target.code),
          at: at(node),
          snippet: snippet(node),
          seq: seq++,
          via,
        });
        return;
      }
      if (name === "is_user_logged_in" || name === "is_super_admin") {
        events.push({
          type: "check",
          fn: name,
          cap: name,
          dynamic: false,
          objectArgs: 0,
          rank: name === "is_user_logged_in" ? 0 : 5,
          meta: false,
          needsObject: false,
          condition: conditionOf(stack, target.code),
          at: at(node),
          snippet: snippet(node),
          seq: seq++,
          via,
        });
        return;
      }
      if (name && name in NONCES) {
        const action = args[NONCES[name]];
        events.push({ type: "nonce", fn: name, action: action ? squash(sourceOf(target.code, action)) : "", at: at(node), snippet: snippet(node), seq: seq++, via });
        return;
      }
      if (name && WRITES.has(name)) {
        events.push({ type: "write", fn: name, at: at(node), snippet: snippet(node), seq: seq++, via });
        return;
      }
      const what = node.what;
      if (what?.kind === "propertylookup" || what?.kind === "nullsafepropertylookup") {
        const method = lower(identName(what.offset));
        const owner = what.what;
        const isWpdb =
          (owner?.kind === "variable" && owner.name === "wpdb") ||
          (owner?.kind === "propertylookup" && lower(identName(owner.offset)) === "wpdb");
        if (isWpdb && WPDB_WRITES.has(method)) {
          events.push({ type: "write", fn: `$wpdb->${method}`, at: at(node), snippet: snippet(node), seq: seq++, via });
          return;
        }
        if (method === "has_cap") {
          const capNode = args[0];
          const cap = capNode?.kind === "string" ? capNode.value : null;
          events.push({
            type: "check",
            fn: "has_cap",
            cap: cap ?? squash(sourceOf(target.code, capNode ?? node)),
            dynamic: cap === null,
            objectArgs: Math.max(0, args.length - 1),
            ...capInfo(cap),
            condition: conditionOf(stack, target.code),
            at: at(node),
            snippet: snippet(node),
            seq: seq++,
            via,
          });
          return;
        }
        if (owner?.kind === "variable" && owner.name === "this" && ctx.className) {
          const found = findMethod(decls, ctx.className, method);
          if (found) run(fromMethod(found, `${found.className}::${method}()`), depth + 1, [...via, `${at(node)} ${found.className}->${method}()`]);
        }
        return;
      }
      if (what?.kind === "staticlookup") {
        const cls = classOf(what.what, ctx);
        const method = identName(what.offset);
        const found = cls && method ? findMethod(decls, cls, method) : null;
        if (found) run(fromMethod(found, `${found.className}::${method}()`), depth + 1, [...via, `${at(node)} ${found.className}::${method}()`]);
        return;
      }
      if (name) {
        const found = decls.functions.get(shortName(name));
        if (found?.length) run({ body: found[0].node.body, path: found[0].path, code: found[0].code, className: null }, depth + 1, [...via, `${at(node)} ${name}()`]);
      }
    };

    // An arrow function's body is one expression; everything else is a block.
    visit(target.body.kind === "block" ? target.body.children : target.body, [{ node: { kind: "root" }, key: "body" }]);
  };

  run(start, 0, []);
  return events;
}

/** The value of an array entry by key (`'methods' => …`). */
const entryOf = (arrayNode, key) => arrayNode?.items?.find((item) => item?.key?.kind === "string" && item.key.value === key)?.value ?? null;

/** The HTTP methods of an endpoint, upper-cased and sorted, so every way of writing them gives one key. */
function restMethods(node, code) {
  const sorted = (text) => [...new Set(text.split(",").map((m) => m.trim().toUpperCase()).filter(Boolean))].sort().join(",");
  if (!node) return "GET";
  if (node.kind === "string") return sorted(node.value);
  if (node.kind === "array") return sorted(node.items.map((i) => restMethods(i.value ?? i, code)).join(","));
  if (node.kind === "staticlookup" && REST_METHODS[identName(node.offset)]) return sorted(REST_METHODS[identName(node.offset)]);
  return squash(sourceOf(code, node));
}

/** Each endpoint of a register_rest_route() call: a single options array, or a list of them. */
function restEndpoints(argsNode) {
  if (!argsNode) return [];
  if (argsNode.kind !== "array") return [null];
  const keyed = argsNode.items.some((i) => i?.key?.kind === "string" && ["methods", "callback", "permission_callback"].includes(i.key.value));
  if (keyed) return [argsNode];
  return argsNode.items.filter((i) => i?.value?.kind === "array" && !(i.key?.kind === "string")).map((i) => i.value);
}

/**
 * Reads every file and returns { entries, unparsed, parsed }. Each entry is one operation:
 * { key, kind, name, registeredAt, audience, handler, permission, capability, gate }.
 */
export function inventory(files) {
  const parsed = [];
  const unparsed = [];
  for (const file of files) {
    const ast = parsePhp(file.code, file.path);
    if (ast) parsed.push({ ...file, ast });
    else unparsed.push(file.path);
  }
  const decls = declarations(parsed);
  const entries = new Map();

  const put = (entry) => {
    if (entries.has(entry.key)) {
      // The same action registered twice: keep both handlers' events, as WordPress runs both.
      const known = entries.get(entry.key);
      known.handlers.push(...entry.handlers);
      known.registeredAt.push(...entry.registeredAt);
      return;
    }
    entries.set(entry.key, entry);
  };

  const handlerOf = (callbackNode, ctx) => {
    const target = resolveCallable(callbackNode, ctx);
    if (!target) return { resolved: false, label: squash(sourceOf(ctx.code, callbackNode ?? {})).slice(0, 120), events: [] };
    if (target.builtin) return { resolved: true, builtin: target.builtin, label: `${target.builtin}()`, events: [] };
    return { resolved: true, label: target.label, events: analyze(target, decls) };
  };

  for (const { path, code, ast } of parsed) {
    const stack = [];
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node.kind !== "string") return;
      const pushed = node.kind === "class" || node.kind === "trait";
      if (pushed) stack.push(lower(identName(node.name)));
      if (node.kind === "call") onCall(node);
      for (const [prop, value] of Object.entries(node)) {
        if (prop === "loc" || prop === "leadingComments" || prop === "trailingComments") continue;
        if (value && typeof value === "object") visit(value);
      }
      if (pushed) stack.pop();
    };

    const onCall = (node) => {
      const name = calledName(node);
      const args = node.arguments ?? [];
      const ctx = { decls, className: stack.at(-1) ?? null, path, code };
      const where = `${path}:${node.loc.start.line}`;
      if ((name === "add_action" || name === "add_filter") && args[0]) {
        const hook = hookName(args[0], code).name;
        const match = /^(wp_ajax|admin_post)_(nopriv_)?(.+)$/.exec(hook);
        if (!match) return;
        const [, family, nopriv, action] = match;
        const kind = `${family === "wp_ajax" ? "ajax" : "admin-post"}${nopriv ? "-nopriv" : ""}`;
        put({
          key: `${kind}:${action}`,
          kind,
          name: action,
          registeredAt: [where],
          audience: nopriv ? "visitors" : "logged-in users",
          baseline: nopriv ? -1 : 0,
          handlers: [handlerOf(args[1], ctx)],
          permission: null,
        });
        return;
      }
      if (name === "register_rest_route" && args.length >= 2) {
        const route = `${hookName(args[0], code).name}/${hookName(args[1], code).name.replace(/^\//, "")}`;
        for (const endpoint of restEndpoints(args[2])) {
          const methods = endpoint ? restMethods(entryOf(endpoint, "methods"), code) : "?";
          const permNode = endpoint ? entryOf(endpoint, "permission_callback") : null;
          put({
            key: `rest:${methods} ${route}`,
            kind: "rest",
            name: `${methods} ${route}`,
            registeredAt: [where],
            audience: "anyone who can reach the site",
            baseline: -1,
            handlers: [endpoint ? handlerOf(entryOf(endpoint, "callback"), ctx) : { resolved: false, label: "(arguments not written in the call)", events: [] }],
            permission: !endpoint ? { resolved: false, events: [] } : permNode ? handlerOf(permNode, ctx) : { resolved: true, missing: true, label: "(none)", events: [] },
          });
        }
        return;
      }
      if (name && name in MENUS) {
        const [capAt, slugAt] = MENUS[name];
        const capNode = args[capAt];
        const slugNode = args[slugAt];
        if (!slugNode) return;
        const slug = hookName(slugNode, code).name;
        const cap = capNode?.kind === "string" ? capNode.value : null;
        const check = {
          type: "check",
          fn: name,
          cap: cap ?? squash(sourceOf(code, capNode ?? node)),
          dynamic: cap === null,
          objectArgs: 0,
          ...capInfo(cap),
          condition: "",
          at: where,
          snippet: clip(squash(sourceOf(code, node))),
          seq: 0,
          via: [],
        };
        put({
          key: `menu:${slug}`,
          kind: "menu",
          name: slug,
          registeredAt: [where],
          audience: "users who can open the admin page",
          baseline: 0,
          handlers: [{ resolved: true, label: name, events: [check] }],
          permission: null,
        });
      }
    };
    visit(ast.children);
  }

  for (const entry of entries.values()) entry.gate = gateOf(entry);
  return { entries, unparsed, parsed: parsed.length };
}

/**
 * Who can run an operation, from its events: { resolved, checks, nonces, writes, rank, opaque, firstCheck,
 * firstWrite }. rank is the lowest default role that gets through (see caps.mjs); null when it depends on
 * something the tool cannot rank (a plugin's own capability, or a permission callback with no check it knows).
 */
export function gateOf(entry) {
  const handlers = entry.handlers;
  const permission = entry.permission;
  const resolved = handlers.every((h) => h.resolved) && (!permission || permission.resolved);
  // A REST permission callback runs before the handler, so its events come first.
  const permEvents = permission?.events ?? [];
  const offset = permEvents.length ? permEvents.at(-1).seq + 1 : 0;
  const events = [...permEvents, ...handlers.flatMap((h) => h.events.map((e) => ({ ...e, seq: e.seq + offset })))];
  const checks = events.filter((e) => e.type === "check");
  const nonces = events.filter((e) => e.type === "nonce");
  const writes = events.filter((e) => e.type === "write");
  if (permission?.builtin === "__return_false") checks.unshift({ type: "check", fn: "permission_callback", cap: "__return_false", rank: 6, dynamic: false, objectArgs: 0, meta: false, needsObject: false, condition: "", at: entry.registeredAt[0], snippet: "'permission_callback' => '__return_false'", seq: -1, via: [] });
  if (permission?.builtin === "is_user_logged_in") checks.unshift({ type: "check", fn: "permission_callback", cap: "is_user_logged_in", rank: 0, dynamic: false, objectArgs: 0, meta: false, needsObject: false, condition: "", at: entry.registeredAt[0], snippet: "'permission_callback' => 'is_user_logged_in'", seq: -1, via: [] });
  // A permission callback of the codebase's own with no check the tool knows (an API key, a custom rule).
  const opaque = Boolean(permission && permission.resolved && !permission.builtin && !permission.missing && !permEvents.some((e) => e.type === "check"));
  const known = checks.filter((c) => c.rank !== null && c.rank !== undefined);
  let rank;
  if (opaque || !resolved) rank = null;
  else if (!checks.length) rank = entry.baseline;
  else if (!known.length) rank = null;
  else rank = Math.max(...known.map((c) => c.rank));
  return {
    resolved,
    checks,
    nonces,
    writes,
    rank,
    opaque,
    publicByDefault: Boolean(permission?.missing),
    firstCheck: checks.length ? Math.min(...checks.map((c) => c.seq)) : null,
    firstWrite: writes.length ? Math.min(...writes.map((w) => w.seq)) : null,
  };
}
