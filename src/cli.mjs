// Command line: capability-diff <base> <head>, or capability-diff --git <base-ref> [<head-ref>].
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { compare, SEVERITY } from "./compare.mjs";
import { inventory } from "./inventory.mjs";
import { JevError } from "./jev.mjs";
import { judge, JUDGED } from "./judge.mjs";
import { markdownReport, summary, textReport } from "./report.mjs";
import { DEFAULT_EXCLUDES, readFolder, readRevision } from "./sources.mjs";

export const USAGE = `capability-diff: compare who can run each operation of a WordPress plugin or theme in two versions.

  capability-diff <base-folder> <head-folder>
  capability-diff --git <base-ref> [<head-ref>]      (no head ref: the files on disk)

Options
  --path <dir>          only this folder of the repository (with --git)
  --exclude <a,b>       folder names to skip (default: ${DEFAULT_EXCLUDES.join(",")})
  --fail-on <level>     exit 1 on wider (default), warning, or never
  --json                print the findings as JSON
  --markdown <file>     also write a Markdown summary (for a pull request or job summary)
  --jev                 ask TypeSafe's Jev about changes the tool cannot rank (needs TYPESAFE_API_KEY)
  --threshold <p>       Jev confidence needed to accept an answer (default 0.8)
  --dry-run             with --jev: say how many questions would be sent, and send nothing
  --help
`;

const EXIT = { ok: 0, failed: 1, usage: 2 };

/** Operations whose callback the tool could not follow: named so a reader knows what was not compared. */
const unresolvedOf = (inv) => [...inv.entries.values()].filter((e) => !e.gate.resolved).map((e) => `${e.kind} ${e.name} (${e.registeredAt[0]})`);

export async function main(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, env = process.env, fetchImpl } = {},
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        git: { type: "boolean" },
        path: { type: "string" },
        exclude: { type: "string" },
        "fail-on": { type: "string", default: "wider" },
        json: { type: "boolean" },
        markdown: { type: "string" },
        jev: { type: "boolean" },
        threshold: { type: "string", default: "0.8" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean" },
      },
    });
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    stdout.write(USAGE);
    return EXIT.ok;
  }
  const failOn = values["fail-on"];
  if (!["wider", "warning", "never"].includes(failOn)) {
    stderr.write("--fail-on must be wider, warning or never\n");
    return EXIT.usage;
  }
  const threshold = Number(values.threshold);
  if (!(threshold > 0.5 && threshold < 1)) {
    stderr.write("--threshold must be between 0.5 and 1\n");
    return EXIT.usage;
  }
  const excludes = values.exclude ? values.exclude.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_EXCLUDES;

  let baseFiles;
  let headFiles;
  let baseLabel;
  let headLabel;
  try {
    if (values.git) {
      if (positionals.length < 1 || positionals.length > 2) throw new Error("--git takes a base ref and an optional head ref");
      baseLabel = positionals[0];
      headLabel = positionals[1] ?? "working tree";
      baseFiles = readRevision(positionals[0], { excludes, subdir: values.path });
      headFiles = positionals[1]
        ? readRevision(positionals[1], { excludes, subdir: values.path })
        : readFolder(values.path ?? ".", excludes);
    } else {
      if (positionals.length !== 2) throw new Error("give two folders, or --git and a ref");
      [baseLabel, headLabel] = positionals;
      baseFiles = readFolder(positionals[0], excludes);
      headFiles = readFolder(positionals[1], excludes);
    }
  } catch (error) {
    stderr.write(`${error.message.split("\n")[0]}\n\n${USAGE}`);
    return EXIT.usage;
  }

  const base = inventory(baseFiles);
  const head = inventory(headFiles);
  let findings = compare(base.entries, head.entries);
  let usage = null;

  if (values.jev && findings.some((f) => JUDGED.has(f.code))) {
    if (values["dry-run"]) {
      const count = findings.filter((f) => JUDGED.has(f.code)).length;
      stdout.write(`Dry run: ${count} finding${count === 1 ? "" : "s"} would be sent to Jev as yes/no questions; nothing was sent.\n`);
    } else {
      try {
        ({ findings, usage } = await judge(findings, {
          threshold,
          fetchImpl,
          apiKey: env.TYPESAFE_API_KEY ?? "",
          model: env.TYPESAFE_MODEL || undefined,
        }));
      } catch (error) {
        if (!(error instanceof JevError)) throw error;
        stderr.write(`${error.message}\nThe report below is without Jev's answers.\n`);
      }
    }
  }

  const context = {
    findings,
    baseLabel,
    headLabel,
    operations: { base: base.entries.size, head: head.entries.size },
    unresolved: [...new Set([...unresolvedOf(base), ...unresolvedOf(head)])],
    unparsed: [...new Set([...base.unparsed, ...head.unparsed])],
  };
  if (values.json) {
    stdout.write(`${JSON.stringify({ ...context, summary: summary(findings), usage }, null, 2)}\n`);
  } else {
    stdout.write(textReport(context));
    if (usage) stdout.write(`Jev: ${usage.requests} request${usage.requests === 1 ? "" : "s"}, ${usage.input_tokens} input tokens.\n`);
  }
  if (values.markdown) writeFileSync(values.markdown, markdownReport(context));

  const floor = failOn === "never" ? Infinity : SEVERITY[failOn];
  return findings.some((f) => SEVERITY[f.severity] >= floor) ? EXIT.failed : EXIT.ok;
}
