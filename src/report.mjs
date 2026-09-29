// The report: plain text for people, JSON for scripts, and a Markdown summary for pull requests.

const LABEL = { wider: "Wider access", warning: "Check", info: "Information" };
const count = (findings, severity) => findings.filter((f) => f.severity === severity).length;

export function summary(findings) {
  return { wider: count(findings, "wider"), warning: count(findings, "warning"), info: count(findings, "info") };
}

function lines(finding) {
  const out = [`  ${finding.kind} ${finding.name}  [${finding.code}]`, `    ${finding.message}`];
  if (finding.base.length) out.push(`    before: ${finding.base.slice(0, 4).join(", ")}${finding.base.length > 4 ? ", …" : ""}`);
  if (finding.head.length) out.push(`    after:  ${finding.head.slice(0, 4).join(", ")}${finding.head.length > 4 ? ", …" : ""}`);
  if (finding.judgment) out.push(`    Jev: ${finding.judgment.answer} (${finding.judgment.probability}) to "${finding.judgment.question}"`);
  return out;
}

export function textReport({ findings, baseLabel, headLabel, operations, unresolved, unparsed }) {
  const totals = summary(findings);
  const out = [
    `capability-diff: ${baseLabel} -> ${headLabel}`,
    `${operations.base} operations before, ${operations.head} after. ${totals.wider} with wider access, ${totals.warning} to check, ${totals.info} for information.`,
  ];
  for (const severity of ["wider", "warning", "info"]) {
    const group = findings.filter((f) => f.severity === severity);
    if (!group.length) continue;
    out.push("", `${LABEL[severity]} (${group.length})`);
    for (const finding of group) out.push(...lines(finding));
  }
  if (unresolved.length) {
    out.push("", `Callbacks the tool could not follow, so not compared (${unresolved.length}): ${unresolved.slice(0, 10).join(", ")}${unresolved.length > 10 ? ", …" : ""}`);
  }
  if (unparsed.length) out.push("", `Could not parse (skipped): ${unparsed.join(", ")}`);
  return out.join("\n") + "\n";
}

const cell = (text) => String(text).replace(/\|/g, "\\|");

/** A short Markdown summary, for a pull request comment or a GitHub Actions job summary. */
export function markdownReport({ findings, baseLabel, headLabel }) {
  const totals = summary(findings);
  const out = [
    `### Capability diff: ${baseLabel} → ${headLabel}`,
    "",
    `${totals.wider} with wider access, ${totals.warning} to check, ${totals.info} for information.`,
  ];
  const shown = findings.filter((f) => f.severity !== "info");
  if (shown.length) {
    out.push("", "| Operation | Change | Where |", "| --- | --- | --- |");
    for (const f of shown) out.push(`| \`${cell(`${f.kind} ${f.name}`)}\` | ${LABEL[f.severity]}: ${f.code} | ${cell(f.head[0] ?? f.base[0] ?? "")} |`);
  }
  return out.join("\n") + "\n";
}
