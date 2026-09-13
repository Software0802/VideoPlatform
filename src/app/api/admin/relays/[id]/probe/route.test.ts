import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const state = vi.hoisted(() => ({
  channel: "image" as "image" | "chat",
  upstream: vi.fn(async () => Response.json({ error: { message: "busy" } }, { status: 503 })),
}));

vi.mock("@/lib/admin", () => ({ requireAdmin: async () => ({ id: "usr_0000000000000001" }) }));
vi.mock("@/lib/providers/grok/client", () => ({ fetchUpstream: state.upstream }));
vi.mock("@/lib/providers/relay/client", () => ({ relayHeaders: () => ({ "content-type": "application/json" }) }));
vi.mock("@/lib/providers/relay/live", () => ({
  relayViewFor: () => ({
    apiKey: () => "fixture-only",
    base: () => "https://fixture.example/v1",
    chatModel: () => "fixture-chat",
    get image() {
      return state.channel === "image" ? { model: () => "fixture-image", shape: () => ({ quality: "medium" }) } : undefined;
    },
  }),
}));

afterEach(() => { vi.clearAllMocks(); });

describe("potentially billed relay probes", () => {
  it.each(["image", "chat"] as const)("forbids retrying an accepted %s POST", async (channel) => {
    state.channel = channel;
    const response = await POST(new Request("http://localhost/api/admin/relays/fixture/probe", { method: "POST" }), {
      params: Promise.resolve({ id: "fixture" }),
    });
    expect(state.upstream).toHaveBeenCalledExactlyOnceWith(
      `https://fixture.example/v1/${channel === "image" ? "images/generations" : "chat/completions"}`,
      expect.objectContaining({ method: "POST" }),
      { maxAttempts: 1 },
    );
    expect(await response.json()).toMatchObject({ ok: false, status: 503, billed: false });
  });
});
