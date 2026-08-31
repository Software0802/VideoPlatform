export type SkillManifest = {
  id: string;
  name: string;
  description: string;
  version: string;
};

export interface SkillLoader {
  load(): Promise<SkillManifest[]>;
}

export const emptySkillLoader: SkillLoader = {
  async load() {
    return [];
  },
};
