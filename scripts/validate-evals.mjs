#!/usr/bin/env node
// @ts-check

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural check for evals/prompts.json plus fixture presence (review 2026-09-05 R03).
 * It still does not generate or score anything: a green run means "inputs are well-formed
 * and every referenced fixture is on disk", nothing more.
 */

const evalsDir = path.dirname(fileURLToPath(new URL("../evals/prompts.json", import.meta.url)));
const document = JSON.parse(await readFile(path.join(evalsDir, "prompts.json"), "utf8"));
const cases = document.cases;
const harnessCases = document.harnessCases;
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
if (!Array.isArray(harnessCases) || harnessCases.length < 6) {
  throw new Error("evals/prompts.json must contain at least 6 harnessCases (30/45/60 coverage)");
}
const ids = new Set([...cases, ...harnessCases].map((item) => item.id));
if (ids.size !== cases.length + harnessCases.length) throw new Error("case ids must be unique");

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

for (const duration of [30, 45, 60]) {
  if (!harnessCases.some((item) => item.durationSec === duration)) {
    throw new Error(`harnessCases must cover ${duration}s`);
  }
}
for (const subject of ["person", "scene"]) {
  if (!harnessCases.some((item) => item.subject === subject)) {
    throw new Error(`harnessCases must include a ${subject} case`);
  }
}
for (const item of harnessCases) {
  if (typeof item.prompt !== "string" || item.prompt.trim().length < 40) {
    throw new Error(`${item.id} needs a full prompt with explicit locks`);
  }
  if (!["zh", "en"].includes(item.language)) throw new Error(`${item.id} has an invalid language`);
  if (![30, 45, 60].includes(item.durationSec)) throw new Error(`${item.id} must be a 30/45/60s harness case`);
  if (!["text_to_video", "image_to_video"].includes(item.mode)) {
    throw new Error(`${item.id}: harness only accepts text_to_video / image_to_video`);
  }
  if (item.mode === "image_to_video" && !item.startFixture) throw new Error(`${item.id} needs a startFixture`);
  if (!["person", "scene"].includes(item.subject)) throw new Error(`${item.id} must declare subject person|scene`);
  if (!Array.isArray(item.expectContinuity) || !item.expectContinuity.length) {
    throw new Error(`${item.id} must declare expectContinuity`);
  }
  const locks = item.language === "zh" ? /保持不变/ : /Keep unchanged/;
  if (!locks.test(item.prompt)) throw new Error(`${item.id} prompt lacks an explicit lock clause`);
}
for (const language of ["zh", "en"]) {
  if (harnessCases.filter((item) => item.language === language).length < 3) {
    throw new Error(`harnessCases need at least 3 ${language} cases`);
  }
}

// Fixture presence: every referenced asset must exist relative to evals/.
const fixtureKeys = ["startFixture", "lastFixture", "sourceFixture"];
const referenced = new Map();
for (const item of [...cases, ...harnessCases]) {
  for (const key of fixtureKeys) {
    if (typeof item[key] === "string") referenced.set(item[key], [...(referenced.get(item[key]) ?? []), item.id]);
  }
  for (const ref of item.referenceFixtures ?? []) {
    referenced.set(ref, [...(referenced.get(ref) ?? []), item.id]);
  }
}
const missing = [];
for (const rel of [...referenced.keys()].sort()) {
  try {
    await access(path.join(evalsDir, rel));
  } catch {
    missing.push(rel);
  }
}
const summary = `evals ok: ${cases.length} native cases, ${harnessCases.length} harness cases, ${referenced.size} fixtures referenced`;
if (missing.length) {
  console.error(`${summary}, ${missing.length} MISSING:`);
  for (const rel of missing) {
    console.error(`  - evals/${rel}  (used by ${[...new Set(referenced.get(rel))].join(", ")})`);
  }
  console.error("Missing fixtures block real-key evals. See evals/README.md → 素材 for provenance rules.");
  process.exit(1);
}
console.log(`${summary}, all fixtures present`);
