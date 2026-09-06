import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * 模板（方案 `docs/plan-frontend-backend-adaptation.md` §3「阶段 B」，`data/templates/*.json`
 * 一文件一条，管理员维护）。`listTemplates()` 按文件名排序、坏文件跳过、按 mtime+大小签名
 * 做进程内缓存——这份测试覆盖读取、跳过、去重与缓存失效四件事。
 */

let dataRoot = "";
let templatesDirAbs = "";
let listTemplates: typeof import("./templates").listTemplates;
let resetTemplateCache: typeof import("./templates").resetTemplateCache;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-templates-test-"));
  process.env.DATA_DIR = dataRoot;
  ({ listTemplates, resetTemplateCache } = await import("./templates"));
  templatesDirAbs = path.join(dataRoot, "templates");
});

beforeEach(() => {
  resetTemplateCache();
});

afterEach(async () => {
  resetTemplateCache();
  await rm(templatesDirAbs, { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

function validTemplate(over: Record<string, unknown> = {}) {
  return {
    id: "tpl-ad-basic",
    name: "广告模板",
    category: "广告",
    prompt: "一支干净利落的产品广告，慢镜头运镜，逆光",
    mode: "text_to_video",
    durationSec: 5,
    aspectRatio: "16:9",
    ...over,
  };
}

async function seedFile(name: string, content: string): Promise<void> {
  await mkdir(templatesDirAbs, { recursive: true });
  await writeFile(path.join(templatesDirAbs, name), content, "utf8");
}

describe("listTemplates — empty / missing directory", () => {
  it("returns an empty array when data/templates does not exist at all", async () => {
    await expect(listTemplates()).resolves.toEqual([]);
  });

  it("returns an empty array when the directory exists but is empty", async () => {
    await mkdir(templatesDirAbs, { recursive: true });
    await expect(listTemplates()).resolves.toEqual([]);
  });
});

describe("listTemplates — reads valid templates, sorted by file name", () => {
  it("returns templates ordered by file name, not by id or content order", async () => {
    await seedFile("02-b.json", JSON.stringify(validTemplate({ id: "tpl-b", name: "B 模板" })));
    await seedFile("01-a.json", JSON.stringify(validTemplate({ id: "tpl-a", name: "A 模板" })));

    const templates = await listTemplates();
    expect(templates.map((t) => t.id)).toEqual(["tpl-a", "tpl-b"]);
  });

  it("ignores non-.json files in the same directory", async () => {
    await seedFile("readme.md", "# not a template");
    await seedFile("01-a.json", JSON.stringify(validTemplate()));

    const templates = await listTemplates();
    expect(templates).toHaveLength(1);
  });
});

describe("listTemplates — a single bad file is skipped, not fatal", () => {
  it("skips a file that is not valid JSON, keeping the others", async () => {
    await seedFile("01-good.json", JSON.stringify(validTemplate({ id: "tpl-good" })));
    await seedFile("02-broken.json", "{ this is not json");

    const templates = await listTemplates();
    expect(templates.map((t) => t.id)).toEqual(["tpl-good"]);
  });

  it("skips a file that fails schema validation (e.g. an unknown mode)", async () => {
    await seedFile("01-good.json", JSON.stringify(validTemplate({ id: "tpl-good" })));
    await seedFile(
      "02-invalid.json",
      JSON.stringify(validTemplate({ id: "tpl-bad-mode", mode: "not_a_real_mode" })),
    );

    const templates = await listTemplates();
    expect(templates.map((t) => t.id)).toEqual(["tpl-good"]);
  });

  it("skips a file with an unexpected extra field (schema is .strict())", async () => {
    await seedFile("01-good.json", JSON.stringify(validTemplate({ id: "tpl-good" })));
    await seedFile(
      "02-extra.json",
      JSON.stringify({ ...validTemplate({ id: "tpl-extra" }), unexpectedField: "x" }),
    );

    expect((await listTemplates()).map((t) => t.id)).toEqual(["tpl-good"]);
  });

  it("skips a duplicate id, keeping the first file (by name order) and dropping the later one", async () => {
    await seedFile("01-first.json", JSON.stringify(validTemplate({ id: "tpl-dup", name: "第一份" })));
    await seedFile("02-second.json", JSON.stringify(validTemplate({ id: "tpl-dup", name: "第二份" })));

    const templates = await listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("第一份");
  });
});

describe("listTemplates — cache invalidates on real file-system changes, no restart needed", () => {
  it("picks up a newly added file on the very next call", async () => {
    await seedFile("01-a.json", JSON.stringify(validTemplate({ id: "tpl-a" })));
    expect((await listTemplates()).map((t) => t.id)).toEqual(["tpl-a"]);

    await seedFile("02-b.json", JSON.stringify(validTemplate({ id: "tpl-b" })));
    expect((await listTemplates()).map((t) => t.id)).toEqual(["tpl-a", "tpl-b"]);
  });

  it("picks up an edited file's new content once its size changes", async () => {
    await seedFile("01-a.json", JSON.stringify(validTemplate({ id: "tpl-a", name: "旧名字" })));
    expect((await listTemplates())[0].name).toBe("旧名字");

    // A longer replacement guarantees a different byte size even if the file system's
    // mtime resolution were coarser than the time between these two writes.
    await seedFile(
      "01-a.json",
      JSON.stringify(validTemplate({ id: "tpl-a", name: "一个刻意写得更长一些的全新模板名字" })),
    );
    expect((await listTemplates())[0].name).toBe("一个刻意写得更长一些的全新模板名字");
  });

  it("reflects files disappearing (all removed) without needing resetTemplateCache", async () => {
    await seedFile("01-a.json", JSON.stringify(validTemplate({ id: "tpl-a" })));
    expect(await listTemplates()).toHaveLength(1);

    await rm(templatesDirAbs, { recursive: true, force: true });
    expect(await listTemplates()).toEqual([]);
  });
});
