"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobPublic } from "@/lib/jobs/schema";
import { formatCny } from "@/lib/billing/prices";
import { MAX_TAGS, MAX_TAG_LEN, PRESET_TAGS, shareJob, tagLength, tagsOf } from "@/lib/client/jobs";
import { isActive } from "@/lib/client/labels";
import { productNameOf } from "@/lib/client/models";
import { fetchTemplates, type Template } from "@/lib/client/templates";
import { IconCheck, IconClose, IconShare, IconStar, IconTrash } from "@/components/genius/icons";
import { SOON, creditsOf, useShell } from "@/components/genius/ShellContext";

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
*/

const BANNER = "/lumina/0450bc8d80da9173.webp";

/** 「全部」不是标签，是「不筛」。 */
const ALL = "全部";
const CATS = [ALL, ...PRESET_TAGS];

const TABS = [
  { id: "video", label: "视频", live: true },
  { id: "image", label: "图片", live: true },
  { id: "template", label: "模板", live: true },
  { id: "challenge", label: "挑战", live: false },
] as const;
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

const SAMPLES: { id: string; prompt: string; kind: Kind; ratio: string }[] = [
  { id: "2e9cde0e2fb0803e", prompt: "玉米田深处，一个穿银色防护服的人走来", kind: "video", ratio: "16:10" },
  { id: "a72d8b509c55bcd0", prompt: "像素风峡谷日出，河流蜿蜒穿过山谷", kind: "video", ratio: "3:4" },
  { id: "a1f3319d0d783e66", prompt: "雨夜的外滩，一位穿深青色风衣的女人走向江边", kind: "image", ratio: "9:16" },
  { id: "f3bfe52263d0656d", prompt: "清晨的山谷薄雾，镜头缓慢推进", kind: "video", ratio: "4:3" },
  { id: "d99c0972e1f99b67", prompt: "霓虹街道，慢速推轨", kind: "image", ratio: "4:5" },
  { id: "a9008119d34b8fc1", prompt: "海岸线航拍，日落前", kind: "video", ratio: "9:16" },
  { id: "5a09f4952b5ad9b6", prompt: "旧仓库里的一束光", kind: "image", ratio: "16:10" },
  { id: "6f297b60448c30c9", prompt: "雪后的胡同口", kind: "video", ratio: "3:4" },
  { id: "0450bc8d80da9173", prompt: "黏土星球，缓慢自转", kind: "video", ratio: "1:1" },
  { id: "5edd8af76572172a", prompt: "水面碎光", kind: "image", ratio: "16:10" },
  { id: "8c0d9035649bec1f", prompt: "低多边形群岛", kind: "video", ratio: "3:4" },
  { id: "fd7b4eb5c10483f5", prompt: "童年玩具巨大化", kind: "image", ratio: "4:3" },
];

function workOf(j: JobPublic): Work | null {
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
      : [`${j.durationSec}s`, j.aspectRatio ?? "16:9", j.resolution ?? "720p", j.generateAudio ? "有声" : "无声"]),
  ];
  // 售价一律人民币 + 积分（¥1 = 100 积分）：界面上不出现美元，那是我们付给上游的成本口径
  if (j.priceCny > 0) parts.push(`${formatCny(j.priceCny)} · ⚡${creditsOf(j.priceCny)}`);
  return {
    key: j.id,
    kind: out.kind,
    still: purged ? PURGED_STILL : image ? out.imageUrl : out.posterUrl,
    media: purged ? "" : image ? out.imageUrl : out.videoUrl,
    prompt: j.prompt || "（无提示词，以首帧为准）",
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
function validFor(expiresAt: string): string {
  const ms = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "24 小时";
  const hours = Math.round(ms / 3_600_000);
  return hours >= 1 && hours <= 24 * 30 ? `${hours} 小时` : "24 小时";
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
  const [tab, setTab] = useState<TabId>("video");
  const [cat, setCat] = useState<string>(ALL);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const works = useMemo(() => jobs.map(workOf).filter((w): w is Work => w !== null), [jobs]);
  const empty = works.length === 0;
  const pool: Work[] = empty
    ? SAMPLES.map((s) => ({
        key: `sample-${s.id}`,
        kind: s.kind,
        still: `/lumina/${s.id}.webp`,
        media: `/lumina/${s.id}.webp`,
        prompt: s.prompt,
        ratio: s.ratio,
        meta: "样片",
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
        <div className="home__banner" style={{ backgroundImage: `url(${BANNER})` }} role="img" aria-label="活动横幅" />

        <div className="home__tabs" role="tablist" aria-label="作品分类">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              className="home__tab"
              aria-selected={tab === t.id}
              aria-disabled={t.live ? undefined : true}
              data-on={tab === t.id}
              onClick={() => (t.live ? setTab(t.id) : showToast(SOON))}
            >
              {t.label}
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
                {c}
              </button>
            ))}
          </div>
        ) : null}

        {tab === "template" ? (
          <TemplateGrid onPick={applyTemplate} />
        ) : (
          <>
            {empty ? (
              <p className="home__empty">还没有作品，下面写一句提示词就能开始。</p>
            ) : list.length ? null : cat === ALL ? (
              <p className="home__empty">还没有{kind === "video" ? "视频" : "图片"}作品。</p>
            ) : (
              <p className="home__empty">这一类还没有作品，换个分类看看。</p>
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
                  title={w.purged ? `${w.prompt}（作品已过期清理）` : w.prompt}
                  onClick={() => setOpenKey(w.key)}
                >
                  <span className="masonry__title">
                    <IconStar size={11} />
                    {short(w.prompt)}
                  </span>
                  {w.purged ? <span className="masonry__purged">作品已过期清理</span> : null}
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
                  {jobsLoading ? "加载中…" : "加载更多"}
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
  const [list, setList] = useState<Template[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchTemplates().then(
      (next) => alive && setList(next),
      (e: unknown) => alive && setErr(e instanceof Error ? e.message : "暂时读不到模板"),
    );
    return () => {
      alive = false;
    };
  }, []);

  if (err) {
    return (
      <p className="home__empty" role="alert">
        {err}
      </p>
    );
  }
  if (!list) return <p className="home__empty">读取模板中…</p>;
  if (!list.length) return <p className="home__empty">还没有可用的模板。</p>;

  return (
    <div className="tpl-grid">
      {list.map((t) => (
        <button
          key={t.id}
          type="button"
          className="tpl-card"
          data-template-id={t.id}
          title={t.prompt}
          onClick={() => onPick(t)}
        >
          <span
            className="tpl-card__cover"
            style={t.cover ? { backgroundImage: `url(${t.cover})` } : undefined}
            aria-hidden="true"
          />
          <span className="tpl-card__name">{t.name}</span>
          <span className="tpl-card__cat">{t.category}</span>
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
          setErr(e instanceof Error ? e.message : "保存标签失败");
        },
      );
    },
    [busy, job, onSaveTags, tags],
  );

  const toggle = useCallback(
    (tag: string) => {
      if (tags.includes(tag)) {
        commit(tags.filter((t) => t !== tag));
        return;
      }
      if (tags.length >= MAX_TAGS) {
        onToast(`最多 ${MAX_TAGS} 个标签`);
        return;
      }
      commit([...tags, tag]);
    },
    [commit, onToast, tags],
  );

  const addDraft = useCallback(() => {
    const value = draft.trim();
    if (!value) return;
    if (tagLength(value) > MAX_TAG_LEN) {
      onToast(`标签最多 ${MAX_TAG_LEN} 个字`);
      return;
    }
    if (tags.includes(value)) {
      setDraft("");
      return;
    }
    if (tags.length >= MAX_TAGS) {
      onToast(`最多 ${MAX_TAGS} 个标签`);
      return;
    }
    setDraft("");
    commit([...tags, value]);
  }, [commit, draft, onToast, tags]);

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
        const span = validFor(link.expiresAt);
        onToast(copied ? `链接已复制，${span}有效` : `链接已生成，${span}有效，请手动复制`);
      },
      (e: unknown) => {
        setBusy(false);
        setErr(e instanceof Error ? e.message : "生成分享链接失败");
      },
    );
  }, [busy, job, onToast]);

  const doDelete = useCallback(() => {
    if (!job || busy) return;
    setBusy(true);
    setErr(null);
    void onDelete(job.id).then(
      () => setBusy(false),
      (e: unknown) => {
        setBusy(false);
        setConfirming(false);
        setErr(e instanceof Error ? e.message : "删除失败");
      },
    );
  }, [busy, job, onDelete]);

  // 进行中的任务服务端会 409 `job_active`；按钮先自己灰掉，不去撞那一下
  const running = !!job && isActive(job.status);
  const shareable = !!job && job.status === "succeeded" && !work.purged;

  return (
    <div className="work" role="dialog" aria-modal="true" aria-label="作品详情" onClick={onClose}>
      <div className="work__panel" onClick={(e) => e.stopPropagation()}>
        <div className="work__media">
          {work.purged ? (
            <p className="work__purged">作品已过期清理，超过留存期的成片与素材已删除，可用这条提示词重新生成。</p>
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
            <span className="work__tags-label">标签</span>
            {[...PRESET_TAGS, ...tags.filter((t) => !(PRESET_TAGS as readonly string[]).includes(t))].map((t) => {
              const on = tags.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  className="work__tag"
                  data-tag={t}
                  data-on={on}
                  aria-pressed={on}
                  disabled={busy}
                  onClick={() => toggle(t)}
                >
                  {on ? <IconCheck size={11} /> : null}
                  {t}
                </button>
              );
            })}
            <input
              className="work__tag-input"
              aria-label="自定义标签"
              placeholder="自定义标签"
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
            {shared.copied ? "链接已复制：" : "请手动复制："}
            <span className="work__shared-url">{shared.url}</span>
          </p>
        ) : null}
        {err ? (
          <p className="work__err" role="alert">
            {err}
          </p>
        ) : null}

        {confirming ? (
          <div className="work__confirm" role="alertdialog" aria-label="确认删除">
            <span className="work__confirm-text">删除后不可恢复，成片与素材一并移除。</span>
            <button type="button" className="work__btn" disabled={busy} onClick={() => setConfirming(false)}>
              取消
            </button>
            <button type="button" className="work__btn work__btn--danger" disabled={busy} onClick={doDelete}>
              {busy ? "删除中…" : "确认删除"}
            </button>
          </div>
        ) : null}

        <div className="work__actions">
          <button type="button" className="work__btn" onClick={onReuse}>
            用这条提示词再生成
          </button>
          {work.purged || work.sample ? null : (
            <a className="work__btn work__btn--light" href={`${work.media}?download=1`} download>
              下载
            </a>
          )}
          {shareable ? (
            <button type="button" className="work__btn work__share" disabled={busy} onClick={share}>
              <IconShare size={13} />
              分享
            </button>
          ) : null}
          {job ? (
            <button
              type="button"
              className="work__btn work__delete"
              disabled={busy || running || confirming}
              title={running ? "任务进行中，先取消再删除" : "删除这件作品"}
              onClick={() => setConfirming(true)}
            >
              <IconTrash size={13} />
              删除
            </button>
          ) : null}
          <button type="button" className="work__close" aria-label="关闭" onClick={onClose}>
            <IconClose size={15} />
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
