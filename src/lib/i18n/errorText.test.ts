import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/client/http";
import { formatMessage, type MessageParams } from "@/lib/i18n/format";
import { errorText, type ErrorTranslate } from "@/lib/i18n/errorText";
import { MESSAGES, type MessageKey } from "@/lib/i18n/messages";

/** 与 `useT()` 同一口径：`MESSAGES` 查表 + `formatMessage` 插值，缺键回 zh-CN 再回键名。 */
function tOf(locale: keyof typeof MESSAGES): ErrorTranslate {
  return (key: MessageKey, params?: MessageParams) =>
    formatMessage(MESSAGES[locale][key] ?? MESSAGES["zh-CN"][key] ?? key, params);
}

describe("errorText", () => {
  it("字典命中时返回该码的文案（zh-CN / en 各自的语言）", () => {
    const e = new ApiError("余额不足，请充值", 402, "insufficient_balance");
    expect(errorText(tOf("zh-CN"), e)).toBe("余额不足，请充值");
    expect(errorText(tOf("en"), e)).toBe("Insufficient balance. Please top up.");
  });

  it("invalid_argument / invalid_state / conflict 在字典文案后拼服务端原文", () => {
    const zh = tOf("zh-CN");
    expect(errorText(zh, new ApiError("生成节点需要提示词", 400, "invalid_argument"))).toBe(
      "请求参数不合法：生成节点需要提示词",
    );
    expect(errorText(zh, new ApiError("该节点当前不需要审批", 409, "invalid_state"))).toBe(
      "当前状态不允许该操作：该节点当前不需要审批",
    );
    expect(errorText(zh, new ApiError("当前状态无法取消", 409, "conflict"))).toBe(
      "当前状态不允许该操作：当前状态无法取消",
    );
    // 英文界面：字典文案是英文，服务端细节原文照贴
    expect(errorText(tOf("en"), new ApiError("缺少文件", 400, "invalid_argument"))).toBe(
      "Invalid request：缺少文件",
    );
  });

  it("未知码回落 unknown 并带 requestId，不显示服务端原文", () => {
    const e = new ApiError("上游内部错误 detail", 502, "kling_9999", "abc12345");
    expect(errorText(tOf("zh-CN"), e)).toBe("操作失败，请稍后再试（请求号 abc12345）");
    expect(errorText(tOf("en"), e)).toBe(
      "Something went wrong. Please try again later. (request abc12345)",
    );
  });

  it("未知码没有 requestId 时不带括号", () => {
    const e = new ApiError("x", 500, "brand_new_code");
    expect(errorText(tOf("zh-CN"), e)).toBe("操作失败，请稍后再试");
    expect(errorText(tOf("en"), e)).toBe("Something went wrong. Please try again later.");
  });

  it("非 ApiError 一律 unknown", () => {
    const zh = tOf("zh-CN");
    expect(errorText(zh, new Error("network down"))).toBe("操作失败，请稍后再试");
    expect(errorText(zh, "oops")).toBe("操作失败，请稍后再试");
    // 没有 code 的 ApiError 也走 unknown（带 requestId 就拼上）
    expect(errorText(zh, new ApiError("x", 500, undefined, "deadbeef"))).toBe(
      "操作失败，请稍后再试（请求号 deadbeef）",
    );
  });
});
