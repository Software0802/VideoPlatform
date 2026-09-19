import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { listAgentSkills, findAgentSkill, listPublicSkills } from "@/lib/agent/skills";
import { fileSkillLoader, parseSkillMarkdown, resetFileSkillCache, skillsDir } from "@/lib/skills/loader";
import { emptySkillLoader } from "@/lib/skills/types";

const dataRoot = mkdtempSync(path.join(tmpdir(), "lumen-skills-test-"));

function writeSkill(id: string, body: string): void {
  const dir = path.join(dataRoot, "skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
}

beforeAll(() => {
  process.env.DATA_DIR = dataRoot;
});

afterEach(() => {
  rmSync(path.join(dataRoot, "skills"), { recursive: true, force: true });
  resetFileSkillCache();
});

afterAll(() => {
  delete process.env.DATA_DIR;
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("parseSkillMarkdown", () => {
  it("读 frontmatter 与正文，认不出的键忽略", () => {
    const manifest = parseSkillMarkdown(
      "unbox",
      ["---", "name: 竖屏开箱", "description: 手持竖屏开箱短片", "version: 2", "kinds: [video]", "zzz: 忽略", "---", "", "正文即约束。"].join("\n"),
    );
    expect(manifest).toEqual({
      id: "unbox",
      name: "竖屏开箱",
      description: "手持竖屏开箱短片",
      version: "2",
      kinds: ["video"],
      systemPrompt: "正文即约束。",
    });
  });

  it("没有 frontmatter、没有名字或没有正文的一律不收", () => {
    expect(parseSkillMarkdown("a", "只有正文")).toBeNull();
    expect(parseSkillMarkdown("a", "---\ndescription: 无名\n---\n正文")).toBeNull();
    expect(parseSkillMarkdown("a", "---\nname: 有名\n---\n   \n")).toBeNull();
  });

  it("CRLF 与 BOM 不影响解析；version 缺省为 1", () => {
    const manifest = parseSkillMarkdown("a", "﻿---\r\nname: 有名\r\n---\r\n正文\r\n");
    expect(manifest).toMatchObject({ version: "1", systemPrompt: "正文" });
  });
});

describe("fileSkillLoader", () => {
  it("目录不存在时返回空数组，不抛", async () => {
    await expect(fileSkillLoader.load()).resolves.toEqual([]);
    expect(skillsDir()).toBe(path.join(dataRoot, "skills"));
  });

  it("按目录名取 id；坏文件只跳过自己", async () => {
    writeSkill("unbox", "---\nname: 竖屏开箱\n---\n手持跟拍。");
    writeSkill("broken", "没有 frontmatter");
    resetFileSkillCache();
    const list = await fileSkillLoader.load();
    expect(list.map((s) => s.id)).toEqual(["unbox"]);
  });
});

describe("技能表合并", () => {
  it("文件技能进技能表、进 /api/agent/skills 的对外形状，且不下发 systemPrompt", async () => {
    writeSkill("unbox", "---\nname: 竖屏开箱\nnameEn: Vertical Unboxing\nkinds: [video]\n---\n手持跟拍。");
    resetFileSkillCache();

    const all = await listAgentSkills();
    const one = all.find((s) => s.id === "unbox");
    expect(one).toMatchObject({
      name: { "zh-CN": "竖屏开箱", en: "Vertical Unboxing" },
      kinds: ["video"],
      systemPrompt: "手持跟拍。",
    });
    expect(await findAgentSkill("unbox")).toMatchObject({ id: "unbox" });

    const dto = (await listPublicSkills()).find((s) => s.id === "unbox");
    expect(dto).toBeDefined();
    expect(dto && "systemPrompt" in dto).toBe(false);
  });

  it("同 id 以内建为准；内建条目本身不受文件影响", async () => {
    writeSkill("cinematic", "---\nname: 冒名顶替\n---\n不该生效。");
    resetFileSkillCache();
    const skill = await findAgentSkill("cinematic");
    expect(skill?.name["zh-CN"]).toBe("电影叙事");
    expect((await listAgentSkills()).filter((s) => s.id === "cinematic")).toHaveLength(1);
  });

  it("emptySkillLoader 下就是内建那 20 条", async () => {
    writeSkill("unbox", "---\nname: 竖屏开箱\n---\n手持跟拍。");
    resetFileSkillCache();
    const builtinOnly = await listAgentSkills(emptySkillLoader);
    expect(builtinOnly.some((s) => s.id === "unbox")).toBe(false);
    expect(builtinOnly).toHaveLength(20);
  });

  it("加载器抛错时退回内建表，不让技能表空掉", async () => {
    const broken = {
      load: async () => {
        throw new Error("boom");
      },
    };
    await expect(listAgentSkills(broken)).resolves.toHaveLength(20);
  });
});
