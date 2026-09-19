/**
 * 文件化技能的清单类型（`docs/architecture.md` §15「Skills 与 workflows 是目录里的
 * 文件，不是 if/else」）。
 *
 * 一条技能 = 一段拼进 system prompt 的创作约束。内建的 20 条写在
 * `src/lib/agent/skills.ts`；这里描述的是**运维放在盘上的那些**——
 * `<DATA_DIR>/skills/<id>/SKILL.md`，改完不必发版（读法见 `loader.ts`）。
 *
 * 形状与 `AgentSkill` 对齐但不相同：清单只有一种语言（谁写谁定），本地化在
 * 合并进技能表时补齐；`id` 由目录名给出，不写在 frontmatter 里。
 */

export type SkillManifest = {
  /** 目录名，全局唯一；与内建技能同名的会被丢掉（内建优先）。 */
  id: string;
  name: string;
  description: string;
  /** frontmatter 的 `version`，只作运维标识，不参与任何判据。 */
  version: string;
  /** 英文名 / 描述；没写就沿用上面那份（界面不会因此空掉）。 */
  nameEn?: string;
  descriptionEn?: string;
  /** 只出哪类产物；缺省两类都行（与 `AgentSkill.kinds` 同义，越界 action 会被丢掉）。 */
  kinds?: ("image" | "video")[];
  /** SKILL.md 正文：拼进 system prompt 的那段约束。 */
  systemPrompt: string;
};

export interface SkillLoader {
  load(): Promise<SkillManifest[]>;
}

/**
 * 什么都不加载的加载器。生产路径走的是 `fileSkillLoader`（`listAgentSkills` 的缺省），
 * 这条只用来把「只有内建那张表」钉成一个可断言的输入。
 */
export const emptySkillLoader: SkillLoader = {
  async load() {
    return [];
  },
};
