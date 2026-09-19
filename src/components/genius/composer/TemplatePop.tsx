"use client";

import { useComposer } from "@/components/genius/ShellContext";
import { IconClose } from "@/components/genius/icons";
import { useT } from "@/components/genius/i18n/I18nProvider";

/**
 * 模板清单弹层：模式行旁的「模板」按钮开它，内容是 `GET /api/templates`
 * （与主页「模板」页签同源）。点一张把提示词、通道与规格回填进面板——走的是主页
 * 那张卡一样的 `applyTemplate`，不是另一套逻辑。
 *
 * 清单确实为空、或读不到时，这枚按钮本来就是灰的（`templateReason`），所以这里只剩
 * 「还在读」这一种空场景。
 */
export function TemplatePop() {
  const { templates, templatesLoaded, applyTemplate, setPop } = useComposer();
  const t = useT();
  return (
    <div className="tpl-pop" role="dialog" aria-label={t("composer.mode.template")}>
      <div className="tpl-pop__head">
        <span className="tpl-pop__title">{t("composer.template.title")}</span>
        <button type="button" className="tpl-pop__close" aria-label={t("common.close")} onClick={() => setPop(null)}>
          <IconClose size={12} />
        </button>
      </div>
      {!templatesLoaded ? <span className="tpl-pop__note">{t("common.loading")}</span> : null}
      {templates.map((item) => (
        <button
          key={item.id}
          type="button"
          className="tpl-pop__item"
          data-template-id={item.id}
          title={item.prompt}
          onClick={() => applyTemplate(item)}
        >
          <span className="tpl-pop__name">{item.name}</span>
          <span className="tpl-pop__meta">{item.category}</span>
        </button>
      ))}
    </div>
  );
}
