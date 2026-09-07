"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobPublic } from "@/lib/jobs/schema";
import { formatCny } from "@/lib/billing/prices";
import { MAX_TAGS, MAX_TAG_LEN, PRESET_TAGS, shareJob, tagLength, tagsOf } from "@/lib/client/jobs";
import { isActive } from "@/lib/client/labels";
import { productNameOf } from "@/lib/client/models";
import { fetchTemplates, type Template } from "@/lib/client/templates";
import { IconCheck, IconClose, IconShare, IconStar, IconTrash } from "@/components/genius/icons";
import { creditsOf, useShell } from "@/components/genius/ShellContext";
import { useT, type Translate } from "@/components/genius/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/messages";

/*
  主页（交接包 §3）：活动横幅 → 标签页 → 分类芯片 → 瀑布流 → 底部悬浮输入条（在 Dock 里）。
  瀑布流展示**本人**成功的作品（SSR 首屏 40 条 + 「加载更多」续页 + 本次会话新任务）；
  一件都没有时回落交接包的样片并给一行「还没有作品」（方案 §5）。

  阶段 B 新增（DOM 契约）：
  - 分页：`.home__more`（按钮）+ `.home__sentinel`（触底自动加载），走
    `GET /api/jobs?before=&limit=&kind=`，视频 / 图片两个页签各自一条游标。
  - 分类芯片真筛选：`.home__cat[data-cat][aria-pressed]`，按 `job.tags` 过滤，「全部」不筛。
  - 详情浮层：`.work__tag[data-tag]` 多选 + `.work__tag-input` 自定义（`PATCH /api/jobs/:id`）、
    `.work__delete`（二次确认 `.work__confirm`）、`.work__share`（复制 `/s/<token>`）。
  - 模板页签：`.tpl-card[data-template-id]`，点一张把提示词 / 模式 / 时长 / 画幅回填面板。

  多语言：标签（`PRESET_TAGS` 与用户自建的那些）是**落盘的数据**，两种语言下都原样显示；
  模板名 / 分类同理来自服务端。分类芯片的「全部」是一个哨兵值而不是标签，`data-cat` 保持
  原值（e2e 与后续筛选逻辑按它取），只有可见文案跟着语言走。
*/

const BANNER = "/lumina/0450bc8d80da9173.webp";

/** 「全部」不是标签，是「不筛」。这是 `data-cat` 上的哨兵值，不翻译（见文件头注释）。 */
const ALL = "全部";
const CATS = [ALL, ...PRESET_TAGS];

const TABS = [
  { id: "video", labelKey: "home.tab.video", live: true },
  { id: "image", labelKey: "home.tab.image", live: true },
  { id: "template", labelKey: "home.tab.template", live: true },
  { id: "challenge", labelKey: "home.tab.challenge", live: false },
] as const satisfies readonly { id: string; labelKey: MessageKey; live: boolean }[];
type TabId = (typeof TABS)[number]["id"];

type Kind = "video" | "image";

type Work = {
  key: string;
  kind: Kind;
  /** 卡片底图：视频取 poster */
  still: string;
  media: string;
  prompt: string;
  ratio: string;
  meta: string;
  purged: boolean;
  sample: boolean;
  tags: string[];
  /** 样片没有对应任务；真作品带着它做标签 / 删除 / 分享 */
  job: JobPublic | null;
};

/** 已清理作品的占位图；绝不去请求已删掉的 /api/media/... */
const PURGED_STILL = "/lumina/purged.svg";

const SAMPLES: { id: string; promptKey: MessageKey; kind: Kind; ratio: string }[] = [
  { id: "2e9cde0e2fb0803e", promptKey: "home.sample.2e9cde0e2fb0803e", kind: "video", ratio: "16:10" },
  { id: "a72d8b509c55bcd0", promptKey: "home.sample.a72d8b509c55bcd0", kind: "video", ratio: "3:4" },
  { id: "a1f3319d0d783e66", promptKey: "home.sample.a1f3319d0d783e66", kind: "image", ratio: "9:16" },
  { id: "f3bfe52263d0656d", promptKey: "home.sample.f3bfe52263d0656d", kind: "video", ratio: "4:3" },
  { id: "d99c0972e1f99b67", promptKey: "home.sample.d99c0972e1f99b67", kind: "image", ratio: "4:5" },
  { id: "a9008119d34b8fc1", promptKey: "home.sample.a9008119d34b8fc1", kind: "video", ratio: "9:16" },
  { id: "5a09f4952b5ad9b6", promptKey: "home.sample.5a09f4952b5ad9b6", kind: "image", ratio: "16:10" },
  { id: "6f297b60448c30c9", promptKey: "home.sample.6f297b60448c30c9", kind: "video", ratio: "3:4" },
  { id: "0450bc8d80da9173", promptKey: "home.sample.0450bc8d80da9173", kind: "video", ratio: "1:1" },
  { id: "5edd8af76572172a", promptKey: "home.sample.5edd8af76572172a", kind: "image", ratio: "16:10" },
  { id: "8c0d9035649bec1f", promptKey: "home.sample.8c0d9035649bec1f", kind: "video", ratio: "3:4" },
  { id: "fd7b4eb5c10483f5", promptKey: "home.sample.fd7b4eb5c10483f5", kind: "image", ratio: "4:3" },
];

function workOf(j: JobPublic, t: Translate): Work | null {
  if (j.status !== "succeeded" || !j.output) return null;
  const purged = Boolean(j.artifactsPurgedAt);
  const out = j.output;
  const image = out.kind === "image";
  // 产品名排在最前（`/api/models` 的对外命名）；老任务没有这个字段就还是原来那行
  const product = productNameOf(j);
  const parts = [
    ...(product ? [product] : []),
    ...(image
      ? [(j.imageResolution ?? "1k").toUpperCase(), j.aspectRatio ?? "16:9"]
      : [
          `${j.durationSec}s`,
          j.aspectRatio ?? "16:9",
          j.resolution ?? "720p",
          j.generateAudio ? t("common.withAudio") : t("common.silent"),
        ]),
  ];
  // 售价一律人民币 + 积分（¥1 = 100 积分）：界面上不出现美元，那是我们付给上游的成本口径
  if (j.priceCny > 0) parts.push(`${formatCny(j.priceCny)} · ⚡${creditsOf(j.priceCny)}`);
  return {
    key: j.id,
    kind: out.kind,
    still: purged ? PURGED_STILL : image ? out.imageUrl : out.posterUrl,
    media: purged ? "" : image ? out.imageUrl : out.videoUrl,
    prompt: j.prompt || t("home.noPrompt"),
    ratio: j.aspectRatio ?? "16:9",
    meta: parts.join(" · "),
    purged,
    sample: false,
    tags: tagsOf(j),
    job: j,
  };
}

/** 标题胶囊只放前 12 字，完整提示词留在 title / 详情浮层里。 */
const short = (text: string) => (text.length > 12 ? `${text.slice(0, 12)}…` : text);
const aspect = (ratio: string) => ratio.replace(":", " / ");

/**
 * 分享链接复制到剪贴板。剪贴板 API 需要安全上下文与焦点，拿不到时不假装成功——
 * 调用方会改口说「请手动复制」，链接本身照常显示在浮层里。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒 / 非安全上下文：往下走，交给用户手动复制
  }
  return false;
}

/** 分享链接的有效期文案。服务端给了 `expiresAt` 就按它说，说不通时回落契约里的 24 小时。 */
function validFor(expiresAt: string, t: Translate): string {
  const ms = Date.parse(expiresAt) - Date.now();
  const fallback = t("home.share.hours", { n: 24 });
  if (!Number.isFinite(ms) || ms <= 0) return fallback;
  const hours = Math.round(ms / 3_600_000);
  return hours >= 1 && hours <= 24 * 30 ? t("home.share.hours", { n: hours }) : fallback;
}

export function HomeView() {
  const {
    jobs,
    reuse,
    showToast,
    applyTemplate,
    hasMoreJobs,
    loadMoreJobs,
    jobsLoading,
    jobsError,
    saveTags,
    removeJob,
  } = useShell();
  const t = useT();
  const [tab, setTab] = useState<TabId>("video");
  const [cat, setCat] = useState<string>(ALL);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const works = useMemo(() => jobs.map((j) => workOf(j, t)).filter((w): w is Work => w !== null), [jobs, t]);
  const empty = works.length === 0;
  const pool: Work[] = empty
    ? SAMPLES.map((s) => ({
        key: `sample-${s.id}`,
        kind: s.kind,
        still: `/lumina/${s.id}.webp`,
        media: `/lumina/${s.id}.webp`,
        prompt: t(s.promptKey),
        ratio: s.ratio,
        meta: t("home.sampleMeta"),
        purged: false,
        sample: true,
        tags: [],
        job: null,
      }))
    : works;

  const gallery = tab !== "template" && tab !== "challenge";
  const kind: Kind = tab === "image" ? "image" : "video";
  const ofKind = pool.filter((w) => w.kind === kind);
  // 「全部」不筛；选了分类就按 `job.tags` 过滤（样片没有标签，自然落选）
  const list = cat === ALL ? ofKind : ofKind.filter((w) => w.tags.includes(cat));
  const current = pool.find((w) => w.key === openKey) ?? null;

  /* 触底自动加载：哨兵进视口就续一页，同时保留「加载更多」按钮（两条路径同一个动作）。 */
  const more = gallery && hasMoreJobs(kind);
  const sentinel = useRef<HTMLDivElement>(null);
  // `loadMoreJobs` 每次 render 都是新函数（它闭包了游标）。把它转发进 ref，观察器就不必
  // 跟着重建——重建一个仍在视口里的哨兵会立刻再触发一次回调。ref 在 effect 里同步。
  const loadRef = useRef(loadMoreJobs);
  useEffect(() => {
    loadRef.current = loadMoreJobs;
  }, [loadMoreJobs]);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !more || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadRef.current(kind);
      },
      // `main` 是视口内的滚动容器，所以按视口判断即可；提前 200px 开始拉
      { rootMargin: "200px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [more, kind, jobsLoading]);

  return (
    <>
      <div className="home">
        {/* 活动横幅：交接时是占位槽，这里放交接包样片，接活动图时换掉即可 */}
        <div
          className="home__banner"
          style={{ backgroundImage: `url(${BANNER})` }}
          role="img"
          aria-label={t("home.banner")}
        />

        <div className="home__tabs" role="tablist" aria-label={t("home.tabs.aria")}>
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className="home__tab"
              aria-selected={tab === item.id}
              aria-disabled={item.live ? undefined : true}
              data-on={tab === item.id}
              onClick={() => (item.live ? setTab(item.id) : showToast(t("common.comingSoon")))}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>

        {gallery ? (
          <div className="home__cats">
            {CATS.map((c) => (
              <button
                key={c}
                type="button"
                className="home__cat"
                data-cat={c}
                data-on={cat === c}
                aria-pressed={cat === c}
                onClick={() => setCat(c)}
              >
                {c === ALL ? t("home.cat.all") : c}
              </button>
            ))}
          </div>
        ) : null}

        {tab === "template" ? (
          <TemplateGrid onPick={applyTemplate} />
        ) : (
          <>
            {empty ? (
              <p className="home__empty">{t("home.empty.noWorks")}</p>
            ) : list.length ? null : cat === ALL ? (
              <p className="home__empty">{kind === "video" ? t("home.empty.noVideo") : t("home.empty.noImage")}</p>
            ) : (
              <p className="home__empty">{t("home.empty.noneInCat")}</p>
            )}

            <div className="masonry">
              {list.map((w) => (
                <button
                  key={w.key}
                  type="button"
                  /* 样片是空态的占位，不是作品：类名必须与真作品分开，否则「无作品时
                     `.masonry__item` 为 0」这条契约（§7.1 #6）就永远不成立。 */
                  className={w.sample ? "masonry__sample" : "masonry__item"}
                  data-kind={w.kind}
                  data-purged={w.purged}
                  data-tags={w.tags.join(",")}
                  /* 样片没有任务；真作品带上 id，分页 / 标签 / 删除三条用例才好指名道姓 */
                  data-job-id={w.job?.id}
                  style={{ aspectRatio: aspect(w.ratio), backgroundImage: `url(${w.still})` }}
                  title={w.purged ? t("home.purged.title", { prompt: w.prompt }) : w.prompt}
                  onClick={() => setOpenKey(w.key)}
                >
                  <span className="masonry__title">
                    <IconStar size={11} />
                    {short(w.prompt)}
                  </span>
                  {w.purged ? <span className="masonry__purged">{t("home.purged.badge")}</span> : null}
                </button>
              ))}
            </div>

            {jobsError ? (
              <p className="home__more-err" role="alert">
                {jobsError}
              </p>
            ) : null}
            {more ? (
              <div className="home__more-wrap">
                <div className="home__sentinel" ref={sentinel} aria-hidden="true" />
                <button
                  type="button"
                  className="home__more"
                  disabled={jobsLoading}
                  onClick={() => loadMoreJobs(kind)}
                >
                  {jobsLoading ? t("common.loading") : t("home.more")}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/*
        详情浮层必须留在 `.home` **外面**：`.home` 带 fade-up（transform/opacity）动画，
        会造出一个层叠上下文，把 z-index:50 的浮层困在里面，于是被 z-index:8 的 `.dock`
        盖住，底部那排按钮（下载 / 关闭）点不到。移出来后它和 `.dock` 在同一个上下文里比。
      */}
      {current ? (
        <WorkDialog
          /* 换一件作品就换一个组件实例：标签草稿 / 确认删除 / 分享链接这些编辑态跟着
             重置，比在 effect 里逐个 setState 复位干净（也不触发级联渲染）。 */
          key={current.key}
          work={current}
          onClose={() => setOpenKey(null)}
          onReuse={() => {
            reuse(current.prompt, current.kind);
            setOpenKey(null);
          }}
          onSaveTags={saveTags}
          onDelete={async (id) => {
            await removeJob(id);
            setOpenKey(null);
          }}
          onToast={showToast}
        />
      ) : null}
    </>
  );
}

/* ── 模板页签 ───────────────────────────────────────────────────────── */

function TemplateGrid({ onPick }: { onPick: (t: Template) => void }) {
  const t = useT();
  const [list, setList] = useState<Template[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchTemplates().then(
      (next) => alive && setList(next),
      (e: unknown) => alive && setErr(e instanceof Error ? e.message : t("home.tpl.error")),
    );
    return () => {
      alive = false;
    };
  }, [t]);

  if (err) {
    return (
      <p className="home__empty" role="alert">
        {err}
      </p>
    );
  }
  if (!list) return <p className="home__empty">{t("home.tpl.loading")}</p>;
  if (!list.length) return <p className="home__empty">{t("home.tpl.empty")}</p>;

  return (
    <div className="tpl-grid">
      {list.map((item) => (
        <button
          key={item.id}
          type="button"
          className="tpl-card"
          data-template-id={item.id}
          title={item.prompt}
          onClick={() => onPick(item)}
        >
          <span
            className="tpl-card__cover"
            style={item.cover ? { backgroundImage: `url(${item.cover})` } : undefined}
            aria-hidden="true"
          />
          <span className="tpl-card__name">{item.name}</span>
          <span className="tpl-card__cat">{item.category}</span>
        </button>
      ))}
    </div>
  );
}

/* ── 作品详情浮层 ───────────────────────────────────────────────────── */

type DialogProps = {
  work: Work;
  onClose: () => void;
  onReuse: () => void;
  onSaveTags: (id: string, tags: string[]) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onToast: (message: string) => void;
};

function WorkDialog({ work, onClose, onReuse, onSaveTags, onDelete, onToast }: DialogProps) {
  const t = useT();
  const job = work.job;
  const [tags, setTags] = useState<string[]>(work.tags);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [shared, setShared] = useState<{ url: string; copied: boolean } | null>(null);

  /** 整组替换：先乐观改本地，失败再退回去并说明原因。 */
  const commit = useCallback(
    (next: string[]) => {
      if (!job || busy) return;
      const before = tags;
      setTags(next);
      setBusy(true);
      setErr(null);
      void onSaveTags(job.id, next).then(
        () => setBusy(false),
        (e: unknown) => {
          setBusy(false);
          setTags(before);
          setErr(e instanceof Error ? e.message : t("home.tags.saveFailed"));
        },
      );
    },
    [busy, job, onSaveTags, t, tags],
  );

  const toggle = useCallback(
    (tag: string) => {
      if (tags.includes(tag)) {
        commit(tags.filter((x) => x !== tag));
        return;
      }
      if (tags.length >= MAX_TAGS) {
        onToast(t("home.tags.max", { n: MAX_TAGS }));
        return;
      }
      commit([...tags, tag]);
    },
    [commit, onToast, t, tags],
  );

  const addDraft = useCallback(() => {
    const value = draft.trim();
    if (!value) return;
    if (tagLength(value) > MAX_TAG_LEN) {
      onToast(t("home.tags.tooLong", { n: MAX_TAG_LEN }));
      return;
    }
    if (tags.includes(value)) {
      setDraft("");
      return;
    }
    if (tags.length >= MAX_TAGS) {
      onToast(t("home.tags.max", { n: MAX_TAGS }));
      return;
    }
    setDraft("");
    commit([...tags, value]);
  }, [commit, draft, onToast, t, tags]);

  const share = useCallback(() => {
    if (!job || busy) return;
    setBusy(true);
    setErr(null);
    void shareJob(job.id).then(
      async (link) => {
        setBusy(false);
        const full = `${window.location.origin}${link.url}`;
        const copied = await copyText(full);
        setShared({ url: full, copied });
        const span = validFor(link.expiresAt, t);
        onToast(copied ? t("home.share.toastCopied", { span }) : t("home.share.toastManual", { span }));
      },
      (e: unknown) => {
        setBusy(false);
        setErr(e instanceof Error ? e.message : t("home.share.failed"));
      },
    );
  }, [busy, job, onToast, t]);

  const doDelete = useCallback(() => {
    if (!job || busy) return;
    setBusy(true);
    setErr(null);
    void onDelete(job.id).then(
      () => setBusy(false),
      (e: unknown) => {
        setBusy(false);
        setConfirming(false);
        setErr(e instanceof Error ? e.message : t("home.delete.failed"));
      },
    );
  }, [busy, job, onDelete, t]);

  // 进行中的任务服务端会 409 `job_active`；按钮先自己灰掉，不去撞那一下
  const running = !!job && isActive(job.status);
  const shareable = !!job && job.status === "succeeded" && !work.purged;

  return (
    <div className="work" role="dialog" aria-modal="true" aria-label={t("home.dialog.aria")} onClick={onClose}>
      <div className="work__panel" onClick={(e) => e.stopPropagation()}>
        <div className="work__media">
          {work.purged ? (
            <p className="work__purged">{t("home.purged.note")}</p>
          ) : work.kind === "video" ? (
            <video src={work.media} poster={work.still} controls playsInline preload="metadata" />
          ) : (
            // 成片走 /api/media（owner 校验 + private,no-cache），本地 <img> 即可
            // eslint-disable-next-line @next/next/no-img-element
            <img src={work.media} alt={work.prompt} />
          )}
        </div>
        <div className="work__info">
          <span className="work__meta">{work.meta}</span>
          <p className="work__prompt">{work.prompt}</p>
        </div>

        {job ? (
          <div className="work__tags">
            <span className="work__tags-label">{t("home.tags.label")}</span>
            {[...PRESET_TAGS, ...tags.filter((x) => !(PRESET_TAGS as readonly string[]).includes(x))].map((tag) => {
              const on = tags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  className="work__tag"
                  data-tag={tag}
                  data-on={on}
                  aria-pressed={on}
                  disabled={busy}
                  onClick={() => toggle(tag)}
                >
                  {on ? <IconCheck size={11} /> : null}
                  {tag}
                </button>
              );
            })}
            <input
              className="work__tag-input"
              aria-label={t("home.tags.custom")}
              placeholder={t("home.tags.custom")}
              value={draft}
              /* 按码点判长度（上面的 `tagLength`）；`maxLength` 数的是 UTF-16 单元，
                 卡在 16 会让一串 emoji 提前被浏览器截断，所以这里放宽一倍只当兜底。 */
              maxLength={MAX_TAG_LEN * 2}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  addDraft();
                }
              }}
            />
          </div>
        ) : null}

        {shared ? (
          <p className="work__shared" data-share-url={shared.url}>
            {shared.copied ? t("home.share.copiedPrefix") : t("home.share.manualPrefix")}
            <span className="work__shared-url">{shared.url}</span>
          </p>
        ) : null}
        {err ? (
          <p className="work__err" role="alert">
            {err}
          </p>
        ) : null}

        {confirming ? (
          <div className="work__confirm" role="alertdialog" aria-label={t("home.delete.confirmAria")}>
            <span className="work__confirm-text">{t("home.delete.confirmText")}</span>
            <button type="button" className="work__btn" disabled={busy} onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="work__btn work__btn--danger" disabled={busy} onClick={doDelete}>
              {busy ? t("home.delete.deleting") : t("home.delete.confirm")}
            </button>
          </div>
        ) : null}

        <div className="work__actions">
          <button type="button" className="work__btn" onClick={onReuse}>
            {t("home.reuse")}
          </button>
          {work.purged || work.sample ? null : (
            <a className="work__btn work__btn--light" href={`${work.media}?download=1`} download>
              {t("common.download")}
            </a>
          )}
          {shareable ? (
            <button type="button" className="work__btn work__share" disabled={busy} onClick={share}>
              <IconShare size={13} />
              {t("common.share")}
            </button>
          ) : null}
          {job ? (
            <button
              type="button"
              className="work__btn work__delete"
              disabled={busy || running || confirming}
              title={running ? t("home.delete.running") : t("home.delete.title")}
              onClick={() => setConfirming(true)}
            >
              <IconTrash size={13} />
              {t("common.delete")}
            </button>
          ) : null}
          <button type="button" className="work__close" aria-label={t("common.close")} onClick={onClose}>
            <IconClose size={15} />
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
