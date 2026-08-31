import { afterEach, describe, expect, it } from "vitest";
import { needsSourceFileUpload, providerForId } from "./router";

const previousForceMock = process.env.LUMEN_FORCE_MOCK;

afterEach(() => {
  if (previousForceMock === undefined) delete process.env.LUMEN_FORCE_MOCK;
  else process.env.LUMEN_FORCE_MOCK = previousForceMock;
});

describe("provider routing", () => {
  it("keeps a persisted mock job on the mock provider", () => {
    delete process.env.LUMEN_FORCE_MOCK;
    expect(providerForId("mock").id).toBe("mock");
  });

  it("resolves persisted Grok jobs independently of current mock mode", () => {
    process.env.LUMEN_FORCE_MOCK = "1";
    expect(providerForId("grok").id).toBe("grok");
  });

  it("rejects unknown persisted providers", () => {
    expect(() => providerForId("unknown" as never)).toThrow(/unknown provider/);
  });

  it("uploads source files only for Grok edit and extend jobs", () => {
    expect(needsSourceFileUpload("grok", "edit_video")).toBe(true);
    expect(needsSourceFileUpload("grok", "extend_video")).toBe(true);
    expect(needsSourceFileUpload("mock", "edit_video")).toBe(false);
    expect(needsSourceFileUpload("grok", "text_to_video")).toBe(false);
  });
});
