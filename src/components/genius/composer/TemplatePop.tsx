"use client";

import { useComposer } from "@/components/genius/ShellContext";
import { IconClose } from "@/components/genius/icons";
import { useT } from "@/components/genius/i18n/I18nProvider";

/**
 * 模板清单弹层：模式行旁的「模板」按钮开它，内容是 `GET /api/templates`
 * （与主页「模板」页签同源）。点一张把提示词、通道与规格回填进面板——走的是主页
 * 那张卡一样的 `applyTemplate`，不是另一套逻辑。
 *
 * 清单为空时这枚按钮本来就是灰的（`modeBlock("template")`），所以这里不做空态。
 */
export function TemplatePop() {
  const { templates, applyTemplate, setPop } = useComposer();
  const t = useT();
  return (
    <div className="tpl-pop" role="dialog" aria-label={t("composer.mode.template")}>
      <div className="tpl-pop__head">
        <span className="tpl-pop__title">{t("composer.template.title")}</span>
        <button type="button" className="tpl-pop__close" aria-label={t("common.close")} onClick={() => setPop(null)}>
          <IconClose size={12} />
        </button>
      </div>
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
