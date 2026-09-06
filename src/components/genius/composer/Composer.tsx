"use client";

import {
  IconArrowUp,
  IconAudio,
  IconBolt,
  IconBroom,
  IconChevron,
  IconClose,
  IconImage,
  IconPicture,
  IconSliders,
  IconVideo,
  IconWand,
} from "@/components/genius/icons";
import {
  COMPOSER_TABS,
  IMAGE_RES,
  SOON,
  VIDEO_MODES,
  VIDEO_RES,
  useShell,
  type ComposerTab,
} from "@/components/genius/ShellContext";
import { SpecsPop } from "@/components/genius/composer/SpecsPop";
import { BuddyPop } from "@/components/genius/composer/BuddyPop";

/*
  创作面板（交接包 §4）。悬浮层，`main` 的兄弟节点，贴内容区底部；主页与创作页共用
  同一个实例（状态在 ShellContext 里）。后端接得住的只有视频页「图文」与图片页「默认」，
  其余模式与整个音频页按用户决定「画出来但置灰」，点击提示「即将上线」（方案 §4）。

  DOM 契约见方案 §7：`.composer[data-open][data-tab][data-mode]`、`role=tab/radio/switch`、
  `.composer__specs` / `.specs-pop` / `.composer__send` / `.composer__credits` / `.composer__error`。
*/

const TAB_ICON = { video: IconVideo, image: IconPicture, audio: IconAudio } as const;

const PLACEHOLDER: Record<ComposerTab, string> = {
  video: "描述你想用 Genius AI 创作的内容",
  image: "描述你想用 Genius AI 创作的图片，例如：一张具有高级感的香水产品海报",
  audio: "输入你想让 Genius AI 转换为语音的文本",
};

/** 规格芯片里的分隔：视觉是 1px 竖线，文本仍是 ` | `，读屏与断言拿到的是完整一行。 */
const Sep = () => <span className="composer__sep"> | </span>;

export function Composer({ visible, fileRef }: { visible: boolean; fileRef: React.RefObject<HTMLInputElement | null> }) {
  const s = useShell();
  const isVideo = s.tab === "video";
  const isImage = s.tab === "image";
  const isAudio = s.tab === "audio";
  const soon = isAudio;

  const resLabel = isImage
    ? (IMAGE_RES.find((r) => r.id === s.imageRes)?.label ?? "1K")
    : (VIDEO_RES.find((r) => r.id === s.res)?.label ?? "720P");
  /*
    `data-mode` 报的是**后端模式**而不是模式行上的中文名（契约 §7）：中文名里「图文」
    一个词同时盖住文生视频与图生视频，放首帧时这个属性就不会变，也就证明不了面板确实
    切了通道。音频页后端没有对应模式，单独标 `audio`。
  */
  const modeAttr = isAudio ? "audio" : s.nativeMode;
  const modelName = `${isImage ? s.caps.imageModel : s.caps.videoModel}${s.caps.mock ? " · 模拟" : ""}`;

  function send() {
    if (soon) {
      s.showToast(SOON);
      return;
    }
    s.submit();
  }

  return (
    <form
      className="composer"
      data-open={visible}
      data-tab={s.tab}
      data-mode={modeAttr}
      data-soon={soon}
      hidden={!visible}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {s.pop === "buddy" ? <BuddyPop /> : null}

      <div className="composer__tabs" role="tablist" aria-label="创作类型">
        {COMPOSER_TABS.map((t) => {
          const Icon = TAB_ICON[t.id];
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              className="composer__tab"
              aria-selected={s.tab === t.id}
              data-on={s.tab === t.id}
              onClick={() => s.pickTab(t.id)}
            >
              <Icon size={13} />
              {t.label}
            </button>
          );
        })}
        {s.collapsed ? <span className="composer__collapsed-hint">收起面板</span> : null}
      </div>

      <div className="composer__panel">
        {/* ── 模式行 ── */}
        <div className="composer__modes">
          {isVideo ? (
            <div className="composer__radios" role="radiogroup" aria-label="创作模式">
              {VIDEO_MODES.map((m) => {
                const usable = m === "图文";
                return (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    className="composer__mode"
                    aria-checked={s.mode === m}
                    aria-disabled={usable ? undefined : true}
                    data-on={s.mode === m}
                    data-soon={!usable}
                    title={usable ? undefined : SOON}
                    onClick={() => s.pickMode(m)}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          ) : null}
          {isImage ? (
            // 图片页只有一条路径（text_to_image），但仍按模式行的语义渲染成单选组
            // （方案 §7.1 #5：`role="radio"` 名「默认」且 `aria-checked="true"`）。
            <div className="composer__radios" role="radiogroup" aria-label="创作模式">
              <button type="button" role="radio" className="composer__mode composer__mode--only" aria-checked data-on>
                <IconPicture size={13} />
                默认
              </button>
            </div>
          ) : null}
          {isAudio ? (
            <div className="composer__radios" role="radiogroup" aria-label="创作模式">
              {["人声", "音乐"].map((m, i) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  className="composer__mode"
                  aria-checked={i === 0}
                  aria-disabled="true"
                  data-soon="true"
                  title={SOON}
                  onClick={() => s.showToast(SOON)}
                >
                  {m}
                </button>
              ))}
            </div>
          ) : null}

          <div className="composer__tools">
            {isVideo ? (
              <button
                type="button"
                className="composer__tool"
                aria-label="创作搭子"
                title="创作搭子"
                data-on={s.pop === "buddy"}
                onClick={() => s.setPop(s.pop === "buddy" ? null : "buddy")}
              >
                <IconWand size={15} />
              </button>
            ) : null}
            <button type="button" className="composer__tool" aria-label="清空" title="清空" onClick={s.clearAll}>
              <IconBroom size={15} />
            </button>
            <button
              type="button"
              className="composer__tool composer__tool--chevron"
              aria-label={s.collapsed ? "展开面板" : "收起面板"}
              title={s.collapsed ? "展开面板" : "收起面板"}
              data-up={s.collapsed}
              onClick={s.toggleCollapsed}
            >
              <IconChevron size={15} />
            </button>
          </div>
        </div>

        {/* ── 输入区 ── */}
        {s.collapsed ? (
          <div className="composer__line">
            <input
              className="composer__input"
              value={s.prompt}
              maxLength={2000}
              aria-label="提示词"
              placeholder={PLACEHOLDER[s.tab]}
              onChange={(e) => s.setPrompt(e.target.value)}
            />
          </div>
        ) : (
          <div className="composer__body">
            {isAudio ? null : (
              <div className="composer__slot" data-state={isImage ? "soon" : (s.image?.state ?? "empty")}>
                {/* 「上传图片」这个名字留给下面真正的 file input：两个元素同名时 getByLabel
                    会命中 2 个（strict 失败），所以槽位按钮只说自己是个选择器。 */}
                <button
                  type="button"
                  className="composer__slot-btn"
                  aria-label={s.image ? "更换图片" : "选择图片"}
                  aria-disabled={isImage ? true : undefined}
                  title={isImage ? SOON : (s.image?.message ?? "选择首帧（放图即转为图生视频）")}
                  onClick={() => (isImage ? s.showToast(SOON) : s.setPop("picker"))}
                >
                  {s.image ? (
                    // 本地 ObjectURL 预览，尺寸由 CSS 固定，不引 next/image
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="composer__slot-img" src={s.image.preview} alt="已选图片" />
                  ) : (
                    <IconImage size={20} />
                  )}
                </button>
                {s.image ? (
                  <button type="button" className="composer__slot-x" aria-label="移除图片" onClick={s.clearImage}>
                    <IconClose size={11} />
                  </button>
                ) : null}
                <input
                  ref={fileRef}
                  className="composer__file"
                  type="file"
                  accept="image/*"
                  aria-label="上传图片"
                  onChange={(e) => {
                    s.pickImage(e.target.files?.[0]);
                    s.setPop(null);
                    e.target.value = "";
                  }}
                />
              </div>
            )}
            <div className="composer__field">
              <textarea
                className="composer__text"
                rows={3}
                value={s.prompt}
                maxLength={2000}
                aria-label="提示词"
                placeholder={PLACEHOLDER[s.tab]}
                onChange={(e) => s.setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              {isAudio ? <span className="composer__count">{s.prompt.length}/10000</span> : null}
            </div>
          </div>
        )}

        {/* ── 选项行 ── */}
        <div className="composer__opts">
          {isAudio ? null : (
            <div className="composer__specs-wrap">
              <button
                type="button"
                className="composer__specs"
                data-on={s.pop === "specs"}
                aria-expanded={s.pop === "specs"}
                onClick={() => s.setPop(s.pop === "specs" ? null : "specs")}
              >
                <span>{resLabel}</span>
                <Sep />
                <span>{s.ratio}</span>
                {isVideo ? (
                  <>
                    <Sep />
                    <span>{s.dur}s</span>
                  </>
                ) : null}
              </button>
              {s.pop === "specs" ? <SpecsPop /> : null}
            </div>
          )}

          {isVideo ? (
            <button
              type="button"
              className="composer__audio"
              role="switch"
              aria-checked={s.audio}
              aria-disabled={s.caps.audioAvailable ? undefined : true}
              onClick={s.toggleAudio}
            >
              音频{s.caps.audioAvailable ? "" : " · 暂不可用"}
              <span className="composer__track" data-on={s.audio} aria-hidden="true">
                <span className="composer__knob" />
              </span>
            </button>
          ) : null}

          {isVideo ? (
            <button type="button" className="composer__multi" role="switch" aria-checked={s.multi} onClick={s.toggleMulti}>
              多镜头
              <span className="composer__track" data-on={s.multi} aria-hidden="true">
                <span className="composer__knob" />
              </span>
            </button>
          ) : null}

          {isImage ? null : (
            <button type="button" className="composer__panelbtn" onClick={() => s.showToast(SOON)}>
              <IconSliders size={13} />
              配置面板
              <span className="composer__pink" aria-hidden="true" />
            </button>
          )}

          {isAudio ? (
            <>
              <button type="button" className="composer__panelbtn" onClick={() => s.showToast(SOON)}>
                Expressive Narrator
              </button>
              <button type="button" className="composer__panelbtn" onClick={() => s.showToast(SOON)}>
                中文（普通话）
              </button>
            </>
          ) : null}

          <div className="composer__cluster">
            {/* 只读文案：模型由服务端按 mode 决定，createJobBodySchema 里没有 model 字段 */}
            <span className="composer__model" title={`当前模型 ${modelName}`}>
              <span className="composer__model-dot" aria-hidden="true" />
              {modelName}
            </span>
            <span className="composer__count-chip">1</span>
            {/* 可访问名恒为「创作」（方案 §7）：按钮里还有 ⚡ 预估积分，不加 aria-label 的话
                名字会变成「创作300」，而且忙碌 / 余额不足时也不能改名——那些状态用 title 说。 */}
            <button
              type="button"
              className="composer__send"
              aria-label="创作"
              data-busy={s.working}
              disabled={s.working || s.quotaExhausted || s.balanceShort}
              title={
                s.working ? "正在创作" : s.quotaExhausted ? "今日额度已用完" : s.balanceShort ? "余额可能不够" : "创作"
              }
              onClick={send}
            >
              创作
              <span className="composer__credits">
                <IconBolt size={11} />
                {s.sendCredits}
              </span>
            </button>
          </div>
        </div>

        {s.notice ? (
          <p className="composer__error" role="alert">
            {s.notice}
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** 收起态输入条（交接包 §3）：点任意位置展开为创作面板。 */
export function ComposerBar() {
  const { openComposer } = useShell();
  return (
    <button type="button" className="bar" onClick={openComposer}>
      <span className="bar__img" aria-hidden="true">
        <IconImage size={17} />
      </span>
      <span className="bar__text">描述你想创作的内容</span>
      <span className="bar__send" aria-hidden="true">
        <IconArrowUp size={15} />
      </span>
    </button>
  );
}
