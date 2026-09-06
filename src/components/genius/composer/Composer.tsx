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
  IconPlay,
  IconSliders,
  IconVideo,
  IconWand,
} from "@/components/genius/icons";
import {
  COMPOSER_TABS,
  COUNTS,
  IMAGE_RES_LABEL,
  RES_LABEL,
  SOON,
  VIDEO_MODES,
  useShell,
  type ComposerTab,
  type Frame,
  type SlotTarget,
} from "@/components/genius/ShellContext";
import { ModelPop } from "@/components/genius/composer/ModelPop";
import { SpecsPop } from "@/components/genius/composer/SpecsPop";
import { BuddyPop } from "@/components/genius/composer/BuddyPop";

/*
  创作面板（交接包 §4）。悬浮层，`main` 的兄弟节点，贴内容区底部；主页与创作页共用
  同一个实例（状态在 ShellContext 里）。

  阶段 A 起后端接得住的是：视频页「图文」（文生 / 图生）、「参考」（多图 →
  `reference_to_video`）、「首尾帧」（两槽 + `lastUploadId`），以及图片页「默认」。后两者
  还要当前产品声明了对应能力，不然照旧置灰。模板 / 编辑 / 动作模仿 / 续写 / 人声与整个
  音频页仍是「画出来但置灰」，点击提示「即将上线」（方案 §4）。

  DOM 契约见方案 §7：`.composer[data-open][data-tab][data-mode]`、`role=tab/radio/switch`、
  `.composer__specs` / `.specs-pop` / `.composer__send` / `.composer__credits` / `.composer__error`。
  阶段 A 新增：`.composer__model[aria-expanded]` + `.model-pop`（`button[data-product-id]`）、
  `.composer__count-chip` + `.count-pop`（`button[data-count]`）、`.composer__slot[data-slot]`、
  `.composer__ref[data-index]`。
*/

const TAB_ICON = { video: IconVideo, image: IconPicture, audio: IconAudio } as const;

/** 上传输入的可访问名。首帧沿用「上传图片」（既有 e2e 依赖），另外两个各自成名，避免同名歧义。 */
const FILE_LABEL: Record<SlotTarget, string> = {
  start: "上传图片",
  last: "上传尾帧图片",
  reference: "上传参考图片",
};

export type FileRefs = Record<SlotTarget, React.RefObject<HTMLInputElement | null>>;

const PLACEHOLDER: Record<ComposerTab, string> = {
  video: "描述你想用 Genius AI 创作的内容",
  image: "描述你想用 Genius AI 创作的图片，例如：一张具有高级感的香水产品海报",
  audio: "输入你想让 Genius AI 转换为语音的文本",
};

/** 规格芯片里的分隔：视觉是 1px 竖线，文本仍是 ` | `，读屏与断言拿到的是完整一行。 */
const Sep = () => <span className="composer__sep"> | </span>;

/** 单张图片槽（首帧 / 尾帧）。空槽点开素材弹窗，有图时可换可删。 */
function Slot({
  target,
  frame,
  disabled,
  inputRef,
}: {
  target: "start" | "last";
  frame: Frame | null;
  /** 图片页没有首帧这条路径：槽照常画出来但置灰（方案「与交接包的有意偏离」）。 */
  disabled: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const s = useShell();
  const last = target === "last";
  const clear = last ? s.clearLastImage : s.clearImage;
  const pick = last ? s.pickLastImage : s.pickImage;
  return (
    <div className="composer__slot" data-slot={target} data-state={disabled ? "soon" : (frame?.state ?? "empty")}>
      {/* 「上传图片」这个名字留给下面真正的 file input：两个元素同名时 getByLabel
          会命中 2 个（strict 失败），所以槽位按钮按用途各自成名。 */}
      <button
        type="button"
        className="composer__slot-btn"
        aria-label={last ? (frame ? "更换尾帧" : "选择尾帧") : frame ? "更换图片" : "选择图片"}
        aria-disabled={disabled ? true : undefined}
        title={
          disabled
            ? SOON
            : (frame?.message ??
              (last ? "选择尾帧（生成会在两帧之间过渡）" : "选择首帧（放图即转为图生视频）"))
        }
        onClick={() => (disabled ? s.showToast(SOON) : s.openPicker(target))}
      >
        {frame ? (
          // 本地 ObjectURL 或「已创建」作品的地址，尺寸由 CSS 固定，不引 next/image
          // eslint-disable-next-line @next/next/no-img-element
          <img className="composer__slot-img" src={frame.preview} alt={last ? "已选尾帧" : "已选图片"} />
        ) : last ? (
          <IconPlay size={20} />
        ) : (
          <IconImage size={20} />
        )}
      </button>
      {frame ? (
        <button type="button" className="composer__slot-x" aria-label={last ? "移除尾帧" : "移除图片"} onClick={clear}>
          <IconClose size={11} />
        </button>
      ) : null}
      <input
        ref={inputRef}
        className="composer__file"
        type="file"
        accept="image/*"
        aria-label={FILE_LABEL[target]}
        onChange={(e) => {
          pick(e.target.files?.[0]);
          s.setPop(null);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** 参考图列表：已选的若干张 + 一个「加一张」槽（到上限就不再渲染）。 */
function RefStrip({ inputRef }: { inputRef: React.RefObject<HTMLInputElement | null> }) {
  const s = useShell();
  return (
    <div className="composer__refs" data-count={s.refs.length}>
      {s.refs.map((f, i) => (
        <div className="composer__ref" key={`${f.preview}-${i}`} data-index={i} data-state={f.state}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="composer__ref-img" src={f.preview} alt={`参考图 ${i + 1}`} title={f.message} />
          <button
            type="button"
            className="composer__slot-x"
            aria-label={`移除参考图 ${i + 1}`}
            onClick={() => s.removeRef(i)}
          >
            <IconClose size={11} />
          </button>
        </div>
      ))}
      {s.refs.length < s.maxRefs ? (
        <button
          type="button"
          className="composer__ref-add"
          aria-label="添加参考图"
          title={`最多 ${s.maxRefs} 张参考图`}
          onClick={() => s.openPicker("reference")}
        >
          <IconImage size={18} />
          <span className="composer__ref-count">
            {s.refs.length}/{s.maxRefs}
          </span>
        </button>
      ) : null}
      <input
        ref={inputRef}
        className="composer__file"
        type="file"
        accept="image/*"
        multiple
        aria-label={FILE_LABEL.reference}
        onChange={(e) => {
          s.addRefImages(e.target.files);
          s.setPop(null);
          e.target.value = "";
        }}
      />
    </div>
  );
}

export function Composer({ visible, fileRefs }: { visible: boolean; fileRefs: FileRefs }) {
  const s = useShell();
  const isVideo = s.tab === "video";
  const isImage = s.tab === "image";
  const isAudio = s.tab === "audio";
  const soon = isAudio;
  const firstLast = isVideo && s.mode === "首尾帧";
  const reference = isVideo && s.mode === "参考";

  const resLabel = isImage ? IMAGE_RES_LABEL[s.imageRes] : RES_LABEL[s.res];
  /*
    `data-mode` 报的是**后端模式**而不是模式行上的中文名（契约 §7）：中文名里「图文」
    一个词同时盖住文生视频与图生视频，放首帧时这个属性就不会变，也就证明不了面板确实
    切了通道。音频页后端没有对应模式，单独标 `audio`。
  */
  const modeAttr = isAudio ? "audio" : s.nativeMode;
  /*
    模型芯片：产品名（用户 2026-09-06 决定只露产品名，不露供应商）。`/api/models` 还没
    回来时退回服务端下发的只读模型名；mock 实例一律加「· 模拟」后缀——不能让一段占位片
    看起来像是真上游出的。
  */
  const modelName = `${s.product?.name ?? (isImage ? s.caps.imageModel : s.caps.videoModel)}${s.caps.mock ? " · 模拟" : ""}`;
  const modelPickable = s.productChoices.length > 0;

  const placeholder = firstLast
    ? "描述你想让 Genius AI 在首帧和尾帧之间创作的内容"
    : reference
      ? "描述你想用参考图创作的内容"
      : PLACEHOLDER[s.tab];

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
                const usable = s.modeUsable(m);
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
              placeholder={placeholder}
              onChange={(e) => s.setPrompt(e.target.value)}
            />
          </div>
        ) : (
          <div className="composer__body">
            {isAudio ? null : reference ? (
              <RefStrip inputRef={fileRefs.reference} />
            ) : (
              <>
                <Slot target="start" frame={s.image} disabled={isImage} inputRef={fileRefs.start} />
                {firstLast ? (
                  <>
                    {/* 首尾帧：两槽中间夹一个三角箭头（交接包 §4.1 图 11） */}
                    <span className="composer__arrow" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="m8 5 9 7-9 7z" />
                      </svg>
                    </span>
                    <Slot target="last" frame={s.lastImage} disabled={false} inputRef={fileRefs.last} />
                  </>
                ) : null}
              </>
            )}
            <div className="composer__field">
              <textarea
                className="composer__text"
                rows={3}
                value={s.prompt}
                maxLength={2000}
                aria-label="提示词"
                placeholder={placeholder}
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
                {/* 首尾帧不给选画幅：成片比例跟着两张帧走（交接包 §4.1 图 11） */}
                {s.ratioUsable ? (
                  <>
                    <Sep />
                    <span>{s.ratio}</span>
                  </>
                ) : null}
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
              aria-disabled={s.audioAvailable ? undefined : true}
              onClick={s.toggleAudio}
            >
              音频{s.audioAvailable ? "" : " · 暂不可用"}
              <span className="composer__track" data-on={s.audio} aria-hidden="true">
                <span className="composer__knob" />
              </span>
            </button>
          ) : null}

          {isVideo && !firstLast ? (
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
            <div className="composer__model-wrap">
              <button
                type="button"
                className="composer__model"
                aria-label={`模型 ${modelName}`}
                aria-expanded={s.pop === "model"}
                aria-disabled={modelPickable ? undefined : true}
                data-on={s.pop === "model"}
                title={modelPickable ? `当前模型 ${modelName}` : `当前模型 ${modelName}（暂无可切换的模型）`}
                onClick={() => (modelPickable ? s.setPop(s.pop === "model" ? null : "model") : undefined)}
              >
                <span className="composer__model-dot" aria-hidden="true" />
                {modelName}
              </button>
              {s.pop === "model" ? <ModelPop /> : null}
            </div>

            <div className="composer__count-wrap">
              <button
                type="button"
                className="composer__count-chip"
                aria-label={`数量 ${s.count}`}
                aria-expanded={s.pop === "count"}
                data-on={s.pop === "count"}
                title="一次生成几条"
                onClick={() => s.setPop(s.pop === "count" ? null : "count")}
              >
                {s.count}
              </button>
              {s.pop === "count" ? (
                <div className="count-pop" role="listbox" aria-label="数量">
                  {COUNTS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="option"
                      data-count={n}
                      aria-selected={s.count === n}
                      onClick={() => s.setCount(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

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
