import Link from "next/link";
import { MESSAGES } from "@/lib/i18n/messages";
import { resolveLocale } from "@/lib/i18n/server";

/**
 * 品牌化 404（review 2026-09-15 U-16）。
 *
 * 坏分享链接（`/s/<坏 token>`）与已删作品的链接原来落到 Next 的默认页：一句英文
 * 「This page could not be found.」，没有品牌、没有中文、没有回家的路。
 *
 * 语言按与分享页同一条链路取（Cookie `lumen_locale` → `Accept-Language`），并且与那一页
 * 同样不挂 `I18nProvider`：这一页要在任何状态下都能渲染，越少东西可以出错越好。
 */
export default async function NotFound() {
  const locale = await resolveLocale();
  const m = MESSAGES[locale];
  return (
    <div className="nf shell" data-ready="true">
      <span className="nf__code">404</span>
      <h1 className="nf__title">{m["common.notFound.title"]}</h1>
      <p className="nf__text">{m["common.notFound.text"]}</p>
      <Link className="nf__home" href="/">
        {m["common.notFound.home"]}
      </Link>
    </div>
  );
}
