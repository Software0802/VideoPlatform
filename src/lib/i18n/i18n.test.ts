import { describe, expect, it } from "vitest";
import { formatMessage } from "@/lib/i18n/format";
import { DEFAULT_LOCALE, LOCALES, isLocale, localeFromAcceptLanguage, parseLocale } from "@/lib/i18n/locales";
import { MESSAGES, ZH_CN } from "@/lib/i18n/messages";

describe("parseLocale", () => {
  it("认得支持的语言，其余一律回默认", () => {
    expect(parseLocale("zh-CN")).toBe("zh-CN");
    expect(parseLocale("en")).toBe("en");
    // Cookie 可能是任何东西：坏值不能让整页崩，也不能变成一个没有字典的语言
    expect(parseLocale("fr")).toBe(DEFAULT_LOCALE);
    expect(parseLocale("")).toBe(DEFAULT_LOCALE);
    expect(parseLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(parseLocale(null)).toBe(DEFAULT_LOCALE);
  });

  it("isLocale 只对字面量为真", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("EN")).toBe(false);
    expect(isLocale(42)).toBe(false);
  });
});

describe("localeFromAcceptLanguage", () => {
  it("按第一个认得出的语言标签决定，不做权重解析", () => {
    expect(localeFromAcceptLanguage("en-US,en;q=0.9")).toBe("en");
    expect(localeFromAcceptLanguage("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh-CN");
    // 繁体也归到简体这一份字典：宁可给中文，也不要莫名其妙变英文
    expect(localeFromAcceptLanguage("zh-TW")).toBe("zh-CN");
    // 前面几个都不认得时接着往后看
    expect(localeFromAcceptLanguage("fr-FR,de;q=0.8,en;q=0.5")).toBe("en");
    expect(localeFromAcceptLanguage("fr-FR,de;q=0.8")).toBe(DEFAULT_LOCALE);
    expect(localeFromAcceptLanguage(null)).toBe(DEFAULT_LOCALE);
    expect(localeFromAcceptLanguage("")).toBe(DEFAULT_LOCALE);
  });
});

describe("formatMessage", () => {
  it("替换 {name} 占位", () => {
    expect(formatMessage("共 {n} 条", { n: 3 })).toBe("共 3 条");
    expect(formatMessage("Up to {n} refs — kept {room}", { n: 7, room: 2 })).toBe("Up to 7 refs — kept 2");
  });

  it("缺参数时原样保留占位，便于肉眼发现漏传", () => {
    expect(formatMessage("共 {n} 条")).toBe("共 {n} 条");
    expect(formatMessage("共 {n} 条", { other: 1 })).toBe("共 {n} 条");
  });
});

describe("字典完整性", () => {
  const zhKeys = Object.keys(ZH_CN).sort();

  it("每种语言的键集合与 zh-CN 完全一致", () => {
    // 类型上 `en/<ns>.ts` 已被 `Record<keyof typeof zh, string>` 逼着补全，但一个 `as`
    // 就能绕过去；这条断言是运行时的那道闸——漏一个键，英文界面上就会露出键名。
    for (const locale of LOCALES) {
      expect(Object.keys(MESSAGES[locale]).sort(), `${locale} 的键集合应与 zh-CN 一致`).toEqual(zhKeys);
    }
  });

  it("没有空字符串值", () => {
    for (const locale of LOCALES) {
      const blank = Object.entries(MESSAGES[locale])
        .filter(([, value]) => typeof value !== "string" || value.trim() === "")
        .map(([key]) => key);
      expect(blank, `${locale} 有空文案`).toEqual([]);
    }
  });

  it("键名的前缀就是它所属的命名空间", () => {
    const namespaces = [
      "common",
      "shell",
      "home",
      "composer",
      "create",
      "agent",
      "canvas",
      "subscription",
      "account",
      "login",
      "share",
    ];
    const strays = zhKeys.filter((key) => !namespaces.some((ns) => key.startsWith(`${ns}.`)));
    expect(strays, "键名必须以命名空间开头").toEqual([]);
  });

  it("同一个键在两种语言里的占位符集合相同", () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of zhKeys) {
      const zh = holes(MESSAGES["zh-CN"][key as keyof typeof ZH_CN]);
      for (const locale of LOCALES) {
        expect(holes(MESSAGES[locale][key as keyof typeof ZH_CN]), `${locale} / ${key} 的占位符对不上`).toEqual(zh);
      }
    }
  });
});
