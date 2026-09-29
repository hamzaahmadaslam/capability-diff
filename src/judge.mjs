// Optional: TypeSafe's Jev judges the findings code cannot settle. Everything else is decided without a model.
import { askJev, noul } from "./jev.mjs";

/** Findings a person would have to read the code to settle. */
export const JUDGED = new Set(["capability-changed", "condition-changed", "new-unchecked"]);

/** Questions per request: each carries a few short code excerpts, well under the 32k-token state budget. */
const BATCH = 25;

const STATE =
  "Two versions of the PHP code of a WordPress plugin or theme. Each question is about one operation a user can trigger (an AJAX action, an admin-post action, a REST endpoint or an admin page) and shows the capability checks, nonce checks and first write in front of it, before and after a change. WordPress roles from widest to narrowest: logged-out visitor, subscriber, contributor, author, editor, administrator, super admin.";

function question(finding) {
  const { before, after } = finding.evidence;
  if (finding.code === "new-unchecked") {
    return noul(
      {
        question: `Can a logged-out visitor or a subscriber run the new operation "${finding.name}" and change stored data?`,
        after,
      },
      {
        true: "Yes: nothing in front of the write stops a visitor or subscriber",
        false: "No: something the code shows (a check, a token, a condition) stops them",
      },
    );
  }
  return noul(
    { question: `Can any user who was denied "${finding.name}" before this change reach it after the change?`, before, after },
    {
      true: "Yes: some users who were refused before get through now",
      false: "No: the same users, or fewer, get through",
    },
  );
}

/** The answer as a word, given the threshold: yes, no or review. */
export const verdict = (p, threshold) => (p >= threshold ? "yes" : p <= 1 - threshold ? "no" : "review");

/**
 * Asks Jev about the judged findings and returns them updated: each gains `judgment` { question, answer,
 * probability }. A confident yes raises the finding to `wider`, a confident no lowers it to `info`, and anything
 * between stays a warning marked review. Returns { findings, usage }.
 */
export async function judge(findings, { threshold = 0.8, ...options } = {}) {
  const targets = findings.filter((f) => JUDGED.has(f.code));
  const usage = { requests: 0, input_tokens: 0 };
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const questions = Object.fromEntries(batch.map((f, j) => [`q${j}`, question(f)]));
    const result = await askJev(STATE, questions, options);
    usage.requests++;
    usage.input_tokens += result.usage?.input_tokens ?? 0;
    batch.forEach((finding, j) => {
      const p = Number(result.answers?.[`q${j}`]?.noul);
      if (!Number.isFinite(p)) return;
      const answer = verdict(p, threshold);
      finding.judgment = { question: questions[`q${j}`].instructions.question, answer, probability: Math.round(p * 100) / 100 };
      if (answer === "yes") finding.severity = "wider";
      if (answer === "no") finding.severity = "info";
    });
  }
  return { findings, usage };
}
