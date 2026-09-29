#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`capability-diff: ${error?.message ?? error}\n`);
    process.exit(2);
  },
);
