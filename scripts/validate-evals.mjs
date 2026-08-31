#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const file = new URL("../evals/prompts.json", import.meta.url);
const document = JSON.parse(await readFile(file, "utf8"));
const cases = document.cases;
const expectedModes = [
  "text_to_video",
  "image_to_video",
  "reference_to_video",
  "edit_video",
  "extend_video",
];

if (document.version !== 1 || !Array.isArray(cases)) {
  throw new Error("evals/prompts.json must contain version=1 and a cases array");
}
if (cases.length !== 20) throw new Error(`expected 20 cases, got ${cases.length}`);
const ids = new Set(cases.map((item) => item.id));
if (ids.size !== cases.length) throw new Error("case ids must be unique");

for (const mode of expectedModes) {
  const group = cases.filter((item) => item.mode === mode);
  if (group.length !== 4) throw new Error(`${mode} must have 4 cases`);
  if (group.filter((item) => item.language === "zh").length !== 2) {
    throw new Error(`${mode} must have 2 Chinese cases`);
  }
  if (group.filter((item) => item.language === "en").length !== 2) {
    throw new Error(`${mode} must have 2 English cases`);
  }
}

for (const item of cases) {
  if (typeof item.prompt !== "string" || !item.prompt.trim()) {
    throw new Error(`${item.id} has an empty prompt`);
  }
  if (!["zh", "en"].includes(item.language)) throw new Error(`${item.id} has an invalid language`);
  if (item.mode === "edit_video") {
    if (![1, 8.7].includes(item.sourceDurationSec)) throw new Error(`${item.id} has an invalid edit boundary`);
    if (item.durationSec !== undefined) throw new Error(`${item.id} must not set durationSec`);
  } else if (item.mode === "extend_video") {
    if (![2, 15].includes(item.sourceDurationSec)) throw new Error(`${item.id} has an invalid extend source boundary`);
    if (![2, 10].includes(item.durationSec)) throw new Error(`${item.id} has an invalid extend duration`);
  } else if (![1, 15].includes(item.durationSec)) {
    throw new Error(`${item.id} has an invalid video duration boundary`);
  }
}

console.log(`evals ok: ${cases.length} cases, ${expectedModes.length} modes, zh/en balanced`);
