// The PHP files of one version of a codebase: a folder on disk, or a git revision of the current repository.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Folders skipped unless asked for: third-party code and tests are not the project's own operations. */
export const DEFAULT_EXCLUDES = ["vendor", "node_modules", ".git", "tests", "test"];

const isPhp = (file) => /\.php$/i.test(file);
const excluded = (rel, excludes) => rel.split("/").some((part) => excludes.includes(part));

/** Every PHP file under `root`, as { path (relative, forward slashes), code }. */
export function readFolder(root, excludes = DEFAULT_EXCLUDES) {
  const out = [];
  const visit = (rel) => {
    for (const name of readdirSync(path.join(root, rel)).sort()) {
      const next = rel ? `${rel}/${name}` : name;
      if (excluded(next, excludes)) continue;
      const full = path.join(root, next);
      if (statSync(full).isDirectory()) visit(next);
      else if (isPhp(name)) out.push({ path: next, code: readFileSync(full, "utf8") });
    }
  };
  visit("");
  return out;
}

/** Every PHP file at a git revision (`main`, `v2.1.0`, a commit), read with `git show`, never checked out. */
export function readRevision(revision, { cwd = process.cwd(), excludes = DEFAULT_EXCLUDES, subdir = "" } = {}) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const prefix = subdir ? `${subdir.replace(/\\/g, "/").replace(/\/$/, "")}/` : "";
  const listed = git("ls-tree", "-r", "--name-only", revision, "--", prefix || ".")
    .split(/\r?\n/)
    .filter((file) => file && isPhp(file));
  return listed
    .map((file) => ({ file, rel: file.slice(prefix.length) }))
    .filter(({ rel }) => !excluded(rel, excludes))
    .map(({ file, rel }) => ({ path: rel, code: git("show", `${revision}:${file}`) }));
}
