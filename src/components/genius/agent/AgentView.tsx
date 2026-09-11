"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, useT } from "@/components/genius/i18n/I18nProvider";
import {
  createAgentSession,
  deleteAgentSession,
  fetchAgentSession,
  fetchAgentSessions,
  fetchAgentSkills,
  isJobPending,
  newAgentTurnId,
  sendAgentMessage,
  type AgentSessionDetail,
  type AgentSessionSummary,
  type AgentSkill,
  type AgentTier,
  type AgentTurnBody,
} from "@/lib/client/agent";
import { fetchProducts, type Product } from "@/lib/client/models";
import AgentAsk, { type AskPop } from "./AgentAsk";
import AgentChat from "./AgentChat";
import AgentPlaza from "./AgentPlaza";
import { shot } from "./data";
import { IconPanelLeft, IconPencil, IconTrash } from "./icons";

type Screen = "home" | "plaza" | "chat";

/** 关掉的技能只存在这台浏览器里（是「我不想在下拉里看到它」，不是账号属性）。 */
const OFF_KEY = "genius.agent.skillsOff";
/** 会话里还有任务没跑完时，多久重拉一次详情。 */
const POLL_MS = 3000;

/**
 * 首次渲染就把「关掉的技能」读出来（`useState` 的惰性初始值），不放进 effect：
 * effect 里 setState 会多渲染一轮，而这份值本来就在首屏之前就能拿到。
 *
 * 服务端渲染时没有 `window`，返回空表——此刻技能列表本来就还没拉回来，两边渲染的
 * 都是空网格，不会有水合差异。
 */
function readOff(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(OFF_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

/**
 * 智能体视图（方案 §1）。
 *
 * 三屏：首页（想法 + 技能）→ 技能广场 → 会话页。数据全部来自服务端：
 * 技能 `GET /api/agent/skills`、产品 `GET /api/models`、会话 `/api/agent/sessions`。
 * 每一轮真的扣一次对话费并按需真的创建生成任务——那些任务就是普通任务，同样出现在
 * 主页的作品流里。
 */
export default function AgentView() {
  const t = useT();
  const { locale } = useI18n();

  const [screen, setScreen] = useState<Screen>("home");
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [session, setSession] = useState<AgentSessionDetail | null>(null);

  const [prompt, setPrompt] = useState("");
  const [pop, setPop] = useState<AskPop>(null);
  const [tier, setTier] = useState<AgentTier>("balanced");
  const [imageProduct, setImageProduct] = useState<string | null>(null);
  const [videoProduct, setVideoProduct] = useState<string | null>(null);
  const [skillHover, setSkillHover] = useState(0);
  const [activeSkill, setActiveSkill] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [off, setOff] = useState<Record<string, boolean>>(readOff);
  /**
   * 这台实例配了对话提供方吗（`GET /api/agent/skills` 的 `available`）。默认 `true`：
   * 技能表回来之前先按可用渲染，不然每次进页面都会闪一下「暂未开放」。
   */
  const [available, setAvailable] = useState(true);

  const [pendingText, setPendingText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 卸载后到达的响应不该再 setState（切走视图、退出登录都会命中）。
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const say = useCallback((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (alive.current) setError(message);
  }, []);

  useEffect(() => {
    fetchAgentSkills().then((res) => {
      if (!alive.current) return;
      setSkills(res.skills);
      setAvailable(res.available);
    }, say);
    // 产品拉不到不该让整页不可用：下拉退回只有「自动」一项，照样能创作。
    fetchProducts().then((list) => alive.current && setProducts(list), () => undefined);
    fetchAgentSessions().then((list) => alive.current && setSessions(list), say);
  }, [say]);

  /* 会话里还有任务没跑完时才轮询；全终态就停下来，别对着一个不会变的东西每 3 秒问一次。 */
  const sessionId = session?.id ?? null;
  const pendingJobs = Boolean(session?.jobs.some(isJobPending));
  useEffect(() => {
    if (!sessionId || !pendingJobs) return;
    const timer = setInterval(() => {
      fetchAgentSession(sessionId).then((next) => {
        if (alive.current) setSession((cur) => (cur && cur.id === next.id ? next : cur));
      }, () => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [sessionId, pendingJobs]);

  const turnBody = useCallback(
    (text: string): AgentTurnBody => ({
      text,
      ...(activeSkill ? { skillId: activeSkill } : {}),
      tier,
      ...(imageProduct ? { imageProduct } : {}),
      ...(videoProduct ? { videoProduct } : {}),
      // 每次调用生成一个：同一句话被用户再发一次就是新的一轮（该再扣一次钱）；
      // 只有同一笔 HTTP 请求的透明重发才共享这个 id，被服务端按重放拦下。
      turnId: newAgentTurnId(),
    }),
    [activeSkill, tier, imageProduct, videoProduct],
  );

  const start = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value || busy || !available) return;
      setError(null);
      setBusy(true);
      setPendingText(value);
      setSession(null);
      setScreen("chat");
      setHistoryOpen(false);
      setPop(null);
      try {
        const next = await createAgentSession(turnBody(value));
        if (!alive.current) return;
        setSession(next);
        setPrompt("");
        fetchAgentSessions().then((list) => alive.current && setSessions(list), () => undefined);
      } catch (e) {
        say(e);
        // 第一轮就失败：回到首页，输入框里的话还在，改一改就能重来。
        if (alive.current) setScreen("home");
      } finally {
        if (alive.current) {
          setBusy(false);
          setPendingText(null);
        }
      }
    },
    [available, busy, say, turnBody],
  );

  const send = useCallback(
    async (text: string) => {
      if (!session || busy || !available) return;
      setError(null);
      setBusy(true);
      setPendingText(text);
      try {
        const next = await sendAgentMessage(session.id, turnBody(text));
        if (alive.current) setSession(next);
      } catch (e) {
        say(e);
      } finally {
        if (alive.current) {
          setBusy(false);
          setPendingText(null);
        }
      }
    },
    [available, busy, say, session, turnBody],
  );

  const open = useCallback(
    async (id: string) => {
      setError(null);
      setHistoryOpen(false);
      setSession(null);
      setPendingText(null);
      setScreen("chat");
      try {
        const next = await fetchAgentSession(id);
        if (alive.current) setSession(next);
      } catch (e) {
        say(e);
        if (alive.current) setScreen("home");
      }
    },
    [say],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteAgentSession(id);
      } catch (e) {
        say(e);
        return;
      }
      if (!alive.current) return;
      setSessions((list) => list.filter((s) => s.id !== id));
      setSession((cur) => (cur?.id === id ? null : cur));
      setScreen((cur) => (cur === "chat" ? "home" : cur));
    },
    [say],
  );

  const toggleSkill = useCallback((id: string) => {
    setOff((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        window.localStorage.setItem(OFF_KEY, JSON.stringify(next));
      } catch {
        /* 存不下就只在本次会话内生效 */
      }
      return next;
    });
  }, []);

  const enabled = skills.filter((s) => !off[s.id]);
  const nameOfProduct = (id: string | null) =>
    (id ? products.find((p) => p.id === id)?.name : undefined) ?? t("agent.auto");

  return (
    <div className="agent-view" data-screen={screen} data-available={available ? "true" : "false"}>
      {screen === "home" ? (
        <>
          <div className="agent-view__scroll">
            <div className="agent-hero">
              <h1 className="agent-hero__title">
                {t("agent.heroLead")}
                <span className="agent-hero__grad">{t("agent.heroAccent")}</span>
              </h1>
              <AgentAsk
                prompt={prompt}
                onPrompt={setPrompt}
                pop={pop}
                onPop={setPop}
                tier={tier}
                onTier={setTier}
                imageProduct={imageProduct}
                onImageProduct={setImageProduct}
                videoProduct={videoProduct}
                onVideoProduct={setVideoProduct}
                products={products}
                skills={enabled}
                skillHover={skillHover}
                onSkillHover={setSkillHover}
                activeSkill={activeSkill}
                onActiveSkill={setActiveSkill}
                onManageSkills={() => {
                  setPop(null);
                  setScreen("plaza");
                }}
                onSend={() => void start(prompt)}
                busy={busy}
                available={available}
              />
              {available ? null : (
                <p className="agent-view__error" data-unavailable="true">
                  {t("agent.unavailable")}
                </p>
              )}
              {error ? <p className="agent-view__error">{error}</p> : null}
            </div>

            <section className="agent-picks">
              <h2 className="agent-picks__title">{t("agent.picksTitle")}</h2>
              <div className="agent-picks__grid">
                {enabled.map((s, i) => (
                  <button
                    type="button"
                    key={s.id}
                    className="agent-card"
                    data-skill-id={s.id}
                    aria-pressed={activeSkill === s.id}
                    data-active={activeSkill === s.id ? "true" : undefined}
                    onClick={() => {
                      setActiveSkill(activeSkill === s.id ? null : s.id);
                      setSkillHover(i);
                    }}
                  >
                    <span className="agent-card__shot" style={{ backgroundImage: `url(${shot(i)})` }} />
                    <span className="agent-card__body">
                      <span className="agent-card__name">{s.name[locale]}</span>
                      <span className="agent-card__desc">{s.desc[locale]}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </div>

          <button
            type="button"
            className="agent-history-btn"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((v) => !v)}
          >
            <IconPanelLeft />
            {t("agent.history")}
          </button>

          {historyOpen ? (
            <aside className="agent-drawer" aria-label={t("agent.historyAria")}>
              <div className="agent-drawer__head">
                <span className="agent-drawer__title">{t("agent.drawerTitle")}</span>
                <button
                  type="button"
                  className="agent-drawer__close"
                  aria-label={t("agent.collapseHistory")}
                  onClick={() => setHistoryOpen(false)}
                >
                  <IconPanelLeft size={15} />
                </button>
              </div>
              <button
                type="button"
                className="agent-drawer__new"
                onClick={() => {
                  setPrompt("");
                  setActiveSkill(null);
                  setSession(null);
                  setHistoryOpen(false);
                }}
              >
                <IconPencil />
                {t("agent.newChat")}
              </button>
              <span className="agent-drawer__label">{t("agent.tasksLabel")}</span>
              {sessions.length === 0 ? (
                <p className="agent-drawer__empty">{t("agent.noSessions")}</p>
              ) : (
                sessions.map((s) => (
                  <div className="agent-drawer__row" key={s.id} data-session-id={s.id}>
                    <button
                      type="button"
                      className="agent-drawer__item"
                      onClick={() => void open(s.id)}
                    >
                      <span className="agent-drawer__item-name">{s.title}</span>
                    </button>
                    <button
                      type="button"
                      className="agent-drawer__item-del"
                      aria-label={t("agent.deleteSession", { title: s.title })}
                      onClick={() => void remove(s.id)}
                    >
                      <IconTrash size={12} />
                    </button>
                  </div>
                ))
              )}
            </aside>
          ) : null}
        </>
      ) : null}

      {screen === "plaza" ? (
        <AgentPlaza skills={skills} off={off} onToggle={toggleSkill} onBack={() => setScreen("home")} />
      ) : null}

      {screen === "chat" ? (
        <AgentChat
          session={session}
          pendingText={pendingText}
          busy={busy}
          error={error}
          available={available}
          skills={skills}
          tier={tier}
          imageName={nameOfProduct(imageProduct)}
          videoName={nameOfProduct(videoProduct)}
          onSend={(text) => void send(text)}
          onBack={() => {
            setScreen("home");
            setError(null);
          }}
          onDelete={() => (session ? void remove(session.id) : undefined)}
        />
      ) : null}
    </div>
  );
}
