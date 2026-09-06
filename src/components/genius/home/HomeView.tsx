"use client";

import { useMemo, useState } from "react";
import type { JobPublic } from "@/lib/jobs/schema";
import { formatCny } from "@/lib/billing/prices";
import { IconClose, IconStar } from "@/components/genius/icons";
import { SOON, creditsOf, useShell } from "@/components/genius/ShellContext";

/*
  主页（交接包 §3）：活动横幅 → 标签页 → 分类芯片 → 瀑布流 → 底部悬浮输入条（在 Dock 里）。
  瀑布流展示**本人**成功的作品（`initialJobs` + 本次会话新任务）；一件都没有时回落交接包
  的样片并给一行「还没有作品」（方案 §5）。
*/

const BANNER = "/lumina/0450bc8d80da9173.webp";

/** 分类芯片：仅样式（后端没有分类维度），「全部」恒选中。 */
const CATS = ["全部", "广告", "电影叙事", "风格艺术", "动物剧场", "特效", "数字人", "动漫游戏", "情绪特写", "音乐"];

const TABS = [
  { id: "video", label: "视频", live: true },
  { id: "image", label: "图片", live: true },
  { id: "template", label: "模板", live: false },
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
  const parts = image
    ? [(j.imageResolution ?? "1k").toUpperCase(), j.aspectRatio ?? "16:9"]
    : [`${j.durationSec}s`, j.aspectRatio ?? "16:9", j.resolution ?? "720p", j.generateAudio ? "有声" : "无声"];
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
  };
}

/** 标题胶囊只放前 12 字，完整提示词留在 title / 详情浮层里。 */
const short = (text: string) => (text.length > 12 ? `${text.slice(0, 12)}…` : text);
const aspect = (ratio: string) => ratio.replace(":", " / ");

export function HomeView() {
  const { jobs, reuse, showToast } = useShell();
  const [tab, setTab] = useState<TabId>("video");
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
      }))
    : works;

  const kind: Kind = tab === "image" ? "image" : "video";
  const list = pool.filter((w) => w.kind === kind);
  const current = list.find((w) => w.key === openKey) ?? null;

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

        <div className="home__cats">
          {CATS.map((c, i) => (
            <button
              key={c}
              type="button"
              className="home__cat"
              data-on={i === 0}
              aria-pressed={i === 0}
              onClick={() => (i === 0 ? undefined : showToast(SOON))}
            >
              {c}
            </button>
          ))}
        </div>

        {empty ? (
          <p className="home__empty">还没有作品，下面写一句提示词就能开始。</p>
        ) : list.length ? null : (
          <p className="home__empty">还没有{kind === "video" ? "视频" : "图片"}作品。</p>
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
      </div>

      {/*
        详情浮层必须留在 `.home` **外面**：`.home` 带 fade-up（transform/opacity）动画，
        会造出一个层叠上下文，把 z-index:50 的浮层困在里面，于是被 z-index:8 的 `.dock`
        盖住，底部那排按钮（下载 / 关闭）点不到。移出来后它和 `.dock` 在同一个上下文里比。
      */}
      {current ? (
        <div className="work" role="dialog" aria-modal="true" aria-label="作品详情" onClick={() => setOpenKey(null)}>
          <div className="work__panel" onClick={(e) => e.stopPropagation()}>
            <div className="work__media">
              {current.purged ? (
                <p className="work__purged">作品已过期清理，超过留存期的成片与素材已删除，可用这条提示词重新生成。</p>
              ) : current.kind === "video" ? (
                <video src={current.media} poster={current.still} controls playsInline preload="metadata" />
              ) : (
                // 成片走 /api/media（owner 校验 + private,no-cache），本地 <img> 即可
                // eslint-disable-next-line @next/next/no-img-element
                <img src={current.media} alt={current.prompt} />
              )}
            </div>
            <div className="work__info">
              <span className="work__meta">{current.meta}</span>
              <p className="work__prompt">{current.prompt}</p>
            </div>
            <div className="work__actions">
              <button
                type="button"
                className="work__btn"
                onClick={() => {
                  reuse(current.prompt, current.kind);
                  setOpenKey(null);
                }}
              >
                用这条提示词再生成
              </button>
              {current.purged || current.sample ? null : (
                <a className="work__btn work__btn--light" href={`${current.media}?download=1`} download>
                  下载
                </a>
              )}
              <button type="button" className="work__close" aria-label="关闭" onClick={() => setOpenKey(null)}>
                <IconClose size={15} />
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
