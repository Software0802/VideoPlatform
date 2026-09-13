import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAlertRequest, notifyAlert, resetAlertDedupe } from "@/lib/alerts";
import { alertWebhookFormat } from "@/lib/env";

const AT = new Date("2026-09-13T12:00:00.000Z");
const URL_ = "https://hooks.example.test/robot";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetAlertDedupe();
});

describe("buildAlertRequest", () => {
  it("generic 与旧行为字节一致：平铺 { event, at, ...payload }，URL 原样", () => {
    const req = buildAlertRequest("generic", URL_, undefined, "disk_low", AT, {
      freePct: 3,
      path: "/opt/genius/data",
      skipped: undefined,
    });
    expect(req.url).toBe(URL_);
    expect(req.body).toBe(
      JSON.stringify({
        event: "disk_low",
        at: AT.toISOString(),
        freePct: 3,
        path: "/opt/genius/data",
        skipped: undefined,
      }),
    );
  });

  it("feishu 无签名时是纯 text 消息体", () => {
    const req = buildAlertRequest("feishu", URL_, undefined, "relay_unhealthy", AT, {
      relay: "a",
      channel: "x",
    });
    expect(req.url).toBe(URL_);
    expect(JSON.parse(req.body)).toEqual({
      msg_type: "text",
      content: { text: "[Lumen] relay_unhealthy\n2026-09-13T12:00:00.000Z\nrelay: a\nchannel: x" },
    });
  });

  it("feishu 签名：timestamp 秒级，sign = base64(HmacSHA256(key=`ts\\nsecret`, \"\"))", () => {
    // 预期值按官方算法离线算出（固定 ts=1700000000, secret=testsecret）。
    const at = new Date("2023-11-14T22:13:20.000Z"); // 1700000000000 ms → 1700000000 s
    const req = buildAlertRequest("feishu", URL_, "testsecret", "test", at, {});
    const body = JSON.parse(req.body);
    expect(body.timestamp).toBe("1700000000");
    expect(body.sign).toBe("AOc8oJ7//5OlQlfWC3nRL0R+IkuzcD1FKcAyibRK9Q8=");
    expect(body.msg_type).toBe("text");
    expect(body.content.text).toBe("[Lumen] test\n2023-11-14T22:13:20.000Z");
  });

  it("dingtalk 无签名时 URL 原样、text 消息体", () => {
    const req = buildAlertRequest("dingtalk", URL_, undefined, "test", AT, { note: "上线验证" });
    expect(req.url).toBe(URL_);
    expect(JSON.parse(req.body)).toEqual({
      msgtype: "text",
      text: { content: "[Lumen] test\n2026-09-13T12:00:00.000Z\nnote: 上线验证" },
    });
  });

  it("dingtalk 签名：URL 追加毫秒 timestamp 与 urlencode(base64(HmacSHA256(secret, `ts\\nsecret`)))", () => {
    const at = new Date("2023-11-14T22:13:20.000Z"); // 1700000000000 ms
    const withQuery = "https://oapi.dingtalk.com/robot/send?access_token=abc";
    const req = buildAlertRequest("dingtalk", withQuery, "SECtestsecret", "test", at, {});
    expect(req.url).toBe(
      "https://oapi.dingtalk.com/robot/send?access_token=abc" +
        "&timestamp=1700000000000" +
        "&sign=7LVwF0dAF3%2F%2BMRRulbpE4y72Ogzykc6bS2nG4I99T4s%3D",
    );
    expect(JSON.parse(req.body).msgtype).toBe("text");
  });

  it("wecom 与钉钉 text 形状相同、无签名且不改 URL", () => {
    const req = buildAlertRequest("wecom", URL_, "ignored", "test", AT, {});
    expect(req.url).toBe(URL_);
    expect(JSON.parse(req.body)).toEqual({
      msgtype: "text",
      text: { content: "[Lumen] test\n2026-09-13T12:00:00.000Z" },
    });
  });
});

describe("alertWebhookFormat", () => {
  it("未设默认 generic；非法值回落 generic 且只 warn 一次", () => {
    delete process.env.ALERT_WEBHOOK_FORMAT;
    expect(alertWebhookFormat()).toBe("generic");

    vi.stubEnv("ALERT_WEBHOOK_FORMAT", "feishu");
    expect(alertWebhookFormat()).toBe("feishu");

    vi.stubEnv("ALERT_WEBHOOK_FORMAT", "slack");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(alertWebhookFormat()).toBe("generic");
    expect(alertWebhookFormat()).toBe("generic");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("notifyAlert", () => {
  it("未配置 URL 返回 false；2xx 返回 true 且命中对应渠道格式", async () => {
    vi.stubEnv("ALERT_WEBHOOK_FORMAT", "wecom");
    delete process.env.ALERT_WEBHOOK_URL;
    expect(await notifyAlert("test")).toBe(false);

    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ALERT_WEBHOOK_URL", URL_);
    expect(await notifyAlert("test", { note: "n" }, `t:${Date.now()}`)).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).msgtype).toBe("text");
  });

  it("去重、非 2xx 与网络异常都返回 false 且不抛", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", URL_);
    vi.stubEnv("ALERT_WEBHOOK_FORMAT", "generic");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("no", { status: 500 }))
      .mockRejectedValueOnce(new Error("boom"));
    vi.stubGlobal("fetch", fetchMock);

    expect(await notifyAlert("test", {}, "dedupe:a")).toBe(true);
    expect(await notifyAlert("test", {}, "dedupe:a")).toBe(false); // 10 分钟窗口内去重
    expect(await notifyAlert("test", {}, "dedupe:b")).toBe(false); // 500
    expect(await notifyAlert("test", {}, "dedupe:c")).toBe(false); // 抛错
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
