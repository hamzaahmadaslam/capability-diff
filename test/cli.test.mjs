import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";
import { fixtureFetch } from "../src/jev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(here, "..", "examples", "before");
const head = path.join(here, "..", "examples", "after");
/** A stand-in key: the fixture fetch never sends it anywhere. */
const KEY = "fixture";

/** Stand-ins for stdout and stderr; pass as { stdout, stderr } or read .out and .err. */
function capture() {
  const out = { text: "", write(chunk) { this.text += chunk; } };
  const err = { text: "", write(chunk) { this.text += chunk; } };
  return { out, err, stdout: out, stderr: err };
}

test("exits 1 on wider access by default, 0 with --fail-on never or when nothing changed", async () => {
  const { out, err } = capture();
  assert.equal(await main([base, head], { stdout: out, stderr: err }), 1);
  assert.match(out.text, /13 operations before, 14 after\. 8 with wider access, 3 to check, 1 for information\./);
  assert.match(out.text, /\[object-dropped\]/);
  assert.equal(await main([base, head, "--fail-on", "never"], capture()), 0);
  assert.equal(await main([base, base], capture()), 0);
});

test("--fail-on warning also fails on findings to check", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "capability-diff-"));
  const write = (name, code) => {
    execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(path.join(dir, name))}, { recursive: true })`]);
    writeFileSync(path.join(dir, name, "p.php"), code);
  };
  write("a", "<?php add_action( 'wp_ajax_x', function () { current_user_can( 'manage_options' ); } );");
  write("b", "<?php add_action( 'wp_ajax_x', function () { current_user_can( 'manage_acme' ); } );");
  assert.equal(await main([path.join(dir, "a"), path.join(dir, "b")], capture()), 0);
  assert.equal(await main([path.join(dir, "a"), path.join(dir, "b"), "--fail-on", "warning"], capture()), 1);
  rmSync(dir, { recursive: true, force: true });
});

test("prints JSON with the evidence and writes a Markdown summary", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "capability-diff-"));
  const { out } = capture();
  const md = path.join(dir, "summary.md");
  await main([base, head, "--json", "--markdown", md, "--fail-on", "never"], { stdout: out, stderr: capture().err });
  const report = JSON.parse(out.text);
  assert.deepEqual(report.summary, { wider: 8, warning: 3, info: 1 });
  assert.deepEqual(report.operations, { base: 13, head: 14 });
  const note = report.findings.find((f) => f.code === "object-dropped");
  assert.equal(note.evidence.before.checks[0].code, "current_user_can( 'edit_post', $post_id )");
  assert.equal(note.evidence.after.first_write.at, "includes/class-admin.php:38");
  const summary = readFileSync(md, "utf8");
  assert.match(summary, /8 with wider access, 3 to check, 1 for information\./);
  assert.match(summary, /\| `rest PATCH,POST,PUT example\/v1\/settings` \| Wider access: check-removed \|/);
  rmSync(dir, { recursive: true, force: true });
});

test("rejects bad input with exit code 2", async () => {
  assert.equal(await main([base], capture()), 2);
  assert.equal(await main([base, head, "--fail-on", "breaking"], capture()), 2);
  assert.equal(await main([base, head, "--threshold", "2"], capture()), 2);
  assert.equal(await main(["--nope"], capture()), 2);
  assert.equal(await main(["--help"], capture()), 0);
});

test("compares two git revisions without checking either out", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "capability-diff-git-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(repo, "p.php"), "<?php add_action( 'wp_ajax_acme', function () { if ( ! current_user_can( 'manage_options' ) ) { die; } update_option( 'a', 1 ); } );");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  writeFileSync(path.join(repo, "p.php"), "<?php add_action( 'wp_ajax_acme', function () { if ( ! current_user_can( 'edit_posts' ) ) { die; } update_option( 'a', 1 ); } );");
  git("commit", "-q", "-am", "two");
  const { out, err } = capture();
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    assert.equal(await main(["--git", "HEAD~1", "HEAD", "--json"], { stdout: out, stderr: err }), 1);
  } finally {
    process.chdir(cwd);
  }
  assert.deepEqual(JSON.parse(out.text).findings.map((f) => `${f.code}:${f.key}`), ["capability-lowered:ajax:acme"]);
  rmSync(repo, { recursive: true, force: true });
});

test("asks Jev only about the findings code cannot settle, and applies its answers", async () => {
  const { fetchImpl, calls } = fixtureFetch((body) => ({
    model: "jev-test",
    // Judged findings in report order: clear_log (capability-changed), dismiss (condition-changed), import (new-unchecked).
    answers: Object.fromEntries(Object.keys(body.questions).map((key, i) => [key, { type: "noul", noul: [0.1, 0.5, 0.95][i] }])),
    usage: { input_tokens: 1200, output_tokens: 3 },
  }));
  const { out, err } = capture();
  await main([base, head, "--jev", "--json", "--fail-on", "never"], { stdout: out, stderr: err, fetchImpl, env: { TYPESAFE_API_KEY: KEY } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
  const questions = Object.values(calls[0].body.questions);
  assert.equal(questions.length, 3);
  assert.ok(questions.every((q) => q.type === "noul" && q.instructions.question.endsWith("?")));
  const report = JSON.parse(out.text);
  const byName = Object.fromEntries(report.findings.filter((f) => f.judgment).map((f) => [f.name, f]));
  assert.equal(byName.example_clear_log.judgment.answer, "no");
  assert.equal(byName.example_clear_log.severity, "info");
  assert.equal(byName.example_dismiss.judgment.answer, "review");
  assert.equal(byName.example_dismiss.severity, "warning");
  assert.equal(byName.example_import.judgment.answer, "yes");
  assert.equal(byName.example_import.severity, "wider");
  assert.deepEqual(report.usage, { requests: 1, input_tokens: 1200 });
});

test("a missing key leaves the report intact and says why", async () => {
  const { out, err } = capture();
  assert.equal(await main([base, head, "--jev"], { stdout: out, stderr: err, env: {} }), 1);
  assert.match(err.text, /TYPESAFE_API_KEY is not set/);
  assert.match(out.text, /8 with wider access/);
});

test("a dry run sends nothing", async () => {
  const { fetchImpl, calls } = fixtureFetch(() => ({ answers: {} }));
  const { out } = capture();
  await main([base, head, "--jev", "--dry-run"], { stdout: out, stderr: capture().err, fetchImpl });
  assert.equal(calls.length, 0);
  assert.match(out.text, /Dry run: 3 findings would be sent/);
});

test("the output and README carry no prices", async () => {
  const { out } = capture();
  await main([base, head, "--json", "--fail-on", "never"], { stdout: out, stderr: capture().err });
  const readme = readFileSync(path.join(here, "..", "README.md"), "utf8");
  for (const text of [out.text, readme]) assert.doesNotMatch(text, /\$\s?\d|USD|cost_usd|per million/i);
});
