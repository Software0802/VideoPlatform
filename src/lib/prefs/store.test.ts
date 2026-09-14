import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dataRoot = "";
let prefsDir: typeof import("./store").prefsDir;
let prefsPath: typeof import("./store").prefsPath;
let readPrefs: typeof import("./store").readPrefs;
let setAgentSkillOff: typeof import("./store").setAgentSkillOff;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "lumen-prefs-test-"));
  process.env.DATA_DIR = dataRoot;
  ({ prefsDir, prefsPath, readPrefs, setAgentSkillOff } = await import("./store"));
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  await rm(dataRoot, { recursive: true, force: true });
});

const owner = (tag: string) => `usr_${tag.padStart(16, "0")}`;

describe("user prefs store", () => {
  it("returns defaults for a missing file without persisting it", async () => {
    const id = owner("a1");
    await expect(readPrefs(id)).resolves.toMatchObject({
      schemaVersion: 1,
      ownerId: id,
      agent: { skillsOff: [] },
    });
    await expect(access(prefsPath(id))).rejects.toThrow();
  });

  it("sets and unsets skills idempotently with sorted unique ids", async () => {
    const id = owner("a2");
    await setAgentSkillOff(id, "video-ad", true);
    const set = await setAgentSkillOff(id, "car-ad", true);
    expect(set.agent.skillsOff).toEqual(["car-ad", "video-ad"]);

    const replay = await setAgentSkillOff(id, "car-ad", true);
    expect(replay).toEqual(set);

    const unset = await setAgentSkillOff(id, "car-ad", false);
    expect(unset.agent.skillsOff).toEqual(["video-ad"]);
    const unsetReplay = await setAgentSkillOff(id, "car-ad", false);
    expect(unsetReplay).toEqual(unset);
  });

  it("rebuilds a corrupt file as empty prefs", async () => {
    const id = owner("a3");
    await mkdir(prefsDir(), { recursive: true });
    await writeFile(prefsPath(id), "{not json", "utf8");
    const rebuilt = await readPrefs(id);
    expect(rebuilt.agent.skillsOff).toEqual([]);
    expect(JSON.parse(await readFile(prefsPath(id), "utf8"))).toEqual(rebuilt);
  });

  it("rejects invalid owner ids before reading or writing", async () => {
    await expect(readPrefs("usr_not-valid")).rejects.toThrow("invalid user id");
    await expect(setAgentSkillOff("usr_not-valid", "car-ad", true)).rejects.toThrow(
      "invalid user id",
    );
  });
});
