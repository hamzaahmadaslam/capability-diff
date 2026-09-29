// Compares the authorization of each operation in two versions and says who gained access.
import { primitiveOf, rankName } from "./caps.mjs";

/** How bad each severity is; --fail-on compares against these. */
export const SEVERITY = { info: 0, warning: 1, wider: 2 };

/** Finding codes and their severity. */
export const CODES = {
  "now-public": "wider",
  "check-removed": "wider",
  "capability-lowered": "wider",
  "object-dropped": "wider",
  "check-after-write": "wider",
  "nonce-removed": "wider",
  "capability-changed": "warning",
  "condition-changed": "warning",
  "new-unchecked": "warning",
  "capability-raised": "info",
  "capability-swapped": "info",
  "nonce-added": "info",
  "check-added": "info",
  added: "info",
  removed: "info",
};

const capsOf = (gate) => [...new Set(gate.checks.map((c) => c.cap.toLowerCase()))].sort();
const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const describe = (gate) =>
  gate.checks.length ? gate.checks.map((c) => (c.objectArgs ? `${c.cap} (for one object)` : c.cap)).join(", ") : "no capability check";
const who = (rank) => (rank === null ? "an unknown set of users" : rankName(rank));
const byPlace = (a, b) => {
  const [fa, la] = [a.slice(0, a.lastIndexOf(":")), Number(a.slice(a.lastIndexOf(":") + 1))];
  const [fb, lb] = [b.slice(0, b.lastIndexOf(":")), Number(b.slice(b.lastIndexOf(":") + 1))];
  return fa.localeCompare(fb) || la - lb;
};
const refs = (entry, gate) => [...new Set([...entry.registeredAt, ...gate.checks.map((c) => c.at), ...gate.nonces.map((n) => n.at)])].sort(byPlace);
const COUNTERPART = { "ajax-nopriv": "ajax", "admin-post-nopriv": "admin-post" };

function finding(code, entry, base, head, message) {
  return {
    code,
    severity: CODES[code],
    key: (head ?? base).key,
    kind: (head ?? base).kind,
    name: (head ?? base).name,
    message,
    base: base ? refs(base, base.gate) : [],
    head: head ? refs(head, head.gate) : [],
    evidence: {
      before: base ? evidenceOf(base) : null,
      after: head ? evidenceOf(head) : null,
    },
  };
}

function evidenceOf(entry) {
  const gate = entry.gate;
  return {
    registered: entry.registeredAt[0],
    handler: entry.handlers.map((h) => h.label).join(", "),
    permission: entry.permission ? entry.permission.label ?? null : undefined,
    rank: gate.rank,
    checks: gate.checks.slice(0, 4).map((c) => ({ code: c.snippet, at: c.at, only_when: c.condition })),
    nonces: gate.nonces.slice(0, 2).map((n) => ({ code: n.snippet, at: n.at })),
    first_write: gate.writes[0] ? { code: gate.writes[0].snippet, at: gate.writes[0].at } : null,
  };
}

/** True when every capability added or dropped between two gates has a known rank. */
function ranked(b, h, baseCaps, headCaps) {
  const rankOf = (gate, cap) => gate.checks.find((c) => c.cap.toLowerCase() === cap)?.rank;
  const known = (r) => r !== null && r !== undefined;
  return headCaps.filter((c) => !baseCaps.includes(c)).every((c) => known(rankOf(h, c))) && baseCaps.filter((c) => !headCaps.includes(c)).every((c) => known(rankOf(b, c)));
}

/** One operation in both versions. */
function compareOne(base, head) {
  const out = [];
  const b = base.gate;
  const h = head.gate;
  if (!b.resolved || !h.resolved) return out;
  const label = head.kind === "menu" ? "The admin page" : "The operation";

  if (b.checks.length && !h.checks.length) {
    out.push(
      finding(
        "check-removed",
        head,
        base,
        head,
        `${label} checked ${describe(b)} before and has no capability check now, so ${who(h.rank)} can run it${h.publicByDefault ? " (the REST route has no permission_callback, which WordPress treats as public)" : ""}.`,
      ),
    );
  } else if (b.rank !== null && h.rank !== null && h.rank < b.rank) {
    const code = h.rank === -1 ? "now-public" : "capability-lowered";
    out.push(
      finding(code, head, base, head, `${label} needed ${who(b.rank)} (${describe(b)}) and now lets in ${who(h.rank)} (${describe(h)}).`),
    );
  } else {
    // A meta capability checked for one object (edit_post, $id) replaced by the same check without the object or
    // by its primitive (edit_posts): any user with the primitive capability now passes, whoever owns the object.
    const dropped = b.checks.find(
      (c) =>
        c.needsObject &&
        c.objectArgs > 0 &&
        !h.checks.some((n) => n.cap.toLowerCase() === c.cap.toLowerCase() && n.objectArgs > 0) &&
        h.checks.some((n) => primitiveOf(n.cap) === primitiveOf(c.cap) && (n.objectArgs === 0 || !n.needsObject)),
    );
    const baseCaps = capsOf(b);
    const headCaps = capsOf(h);
    if (dropped) {
      out.push(
        finding(
          "object-dropped",
          head,
          base,
          head,
          `${label} checked ${dropped.cap} for one object before (${dropped.snippet}); now the check has no object, so any user with ${primitiveOf(dropped.cap)} passes, whoever owns the object.`,
        ),
      );
    } else if (!sameSet(baseCaps, headCaps)) {
      if (!b.checks.length && h.checks.length) {
        out.push(finding("check-added", head, base, head, `${label} now checks ${describe(h)}.`));
      } else if (b.rank !== null && h.rank !== null && h.rank > b.rank) {
        out.push(finding("capability-raised", head, base, head, `${label} needed ${who(b.rank)} and now needs ${who(h.rank)} (${describe(h)}).`));
      } else if (b.rank !== null && h.rank !== null && h.rank === b.rank && ranked(b, h, baseCaps, headCaps)) {
        const added = headCaps.filter((c) => !baseCaps.includes(c));
        const removed = baseCaps.filter((c) => !headCaps.includes(c));
        const change = [added.length ? `now checks ${added.join(", ")}` : "", removed.length ? `no longer checks ${removed.join(", ")}` : ""].filter(Boolean).join(" and ");
        out.push(finding("capability-swapped", head, base, head, `${label} ${change}; it still needs ${who(h.rank)}.`));
      } else {
        out.push(
          finding(
            "capability-changed",
            head,
            base,
            head,
            `${label} checked ${describe(b)} and now checks ${describe(h)}. Whether that lets more users in depends on how the site's roles grant these capabilities.`,
          ),
        );
      }
    } else {
      // Compared without whitespace, so `'a-'.$b` and `'a-' . $b` are the same condition.
      const text = new Map();
      const conditions = (g) =>
        [...new Set(g.checks.map((c) => c.condition).filter(Boolean).map((c) => {
          const bare = c.replace(/\s+/g, "");
          if (!text.has(bare)) text.set(bare, c);
          return bare;
        }))].sort();
      const before = conditions(b);
      const after = conditions(h);
      const show = (list) => list.map((c) => text.get(c)).join(" / ");
      if (!sameSet(before, after) && before.every((c) => after.includes(c))) {
        // Every old check is still there, under the same condition; the new ones only add checks.
        out.push(
          finding("check-added", head, base, head, `${label} adds checks of the same capabilities: ${show(after.filter((c) => !before.includes(c)))}.`),
        );
      } else if (!sameSet(before, after)) {
        out.push(
          finding(
            "condition-changed",
            head,
            base,
            head,
            `${label} checks the same capabilities, but the condition around them changed. Before: ${show(before.filter((c) => !after.includes(c))) || "(none)"}. After: ${show(after.filter((c) => !before.includes(c))) || "(none)"}.`,
          ),
        );
      }
    }
  }

  if (b.firstCheck !== null && b.firstWrite !== null && b.firstCheck < b.firstWrite && h.firstWrite !== null && (h.firstCheck === null || h.firstWrite < h.firstCheck) && h.checks.length) {
    out.push(
      finding(
        "check-after-write",
        head,
        base,
        head,
        `${label} checked the capability before its first write; now it writes first (${h.writes[0].snippet}) and checks afterwards, so the write happens for users who fail the check.`,
      ),
    );
  }
  if (head.kind !== "rest" && head.kind !== "menu") {
    if (b.nonces.length && !h.nonces.length) {
      out.push(
        finding(
          "nonce-removed",
          head,
          base,
          head,
          `${label} verified a nonce before (${b.nonces[0].snippet}) and does not now, so another site can make a logged-in user's browser run it (cross-site request forgery).`,
        ),
      );
    } else if (!b.nonces.length && h.nonces.length) {
      out.push(finding("nonce-added", head, base, head, `${label} now verifies a nonce (${h.nonces[0].snippet}).`));
    }
  }
  return out;
}

/** An operation only in the new version. */
function compareAdded(head, baseEntries) {
  const h = head.gate;
  const counterpart = COUNTERPART[head.kind] ? baseEntries.get(`${COUNTERPART[head.kind]}:${head.name}`) : null;
  const open = h.resolved && h.rank !== null && h.rank <= 0 && !h.checks.some((c) => c.rank === null || c.rank > 0);
  if (open && counterpart && !baseEntries.has(head.key) && h.rank === -1) {
    return finding(
      "now-public",
      head,
      counterpart,
      head,
      `"${head.name}" was only for logged-in users; the change also registers it for visitors who are not logged in, and the handler checks no capability.`,
    );
  }
  if (open && h.writes.length) {
    return finding(
      "new-unchecked",
      head,
      null,
      head,
      `New ${head.kind === "rest" ? "REST endpoint" : "action"} open to ${who(h.rank)} that writes (${h.writes[0].snippet}) without a capability check.`,
    );
  }
  return finding("added", head, null, head, `New ${head.kind} operation, ${h.checks.length ? `checking ${describe(h)}` : `open to ${who(h.rank)}`}.`);
}

/** Every finding between two inventories, most severe first. */
export function compare(baseEntries, headEntries) {
  const out = [];
  for (const [key, base] of baseEntries) {
    const head = headEntries.get(key);
    if (!head) out.push(finding("removed", base, base, null, `The ${base.kind} operation is no longer registered.`));
    else out.push(...compareOne(base, head));
  }
  for (const [key, head] of headEntries) {
    if (!baseEntries.has(key)) out.push(compareAdded(head, baseEntries));
  }
  return out.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || a.key.localeCompare(b.key) || a.code.localeCompare(b.code));
}
