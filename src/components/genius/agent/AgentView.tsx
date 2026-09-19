"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n, useT } from "@/components/genius/i18n/I18nProvider";
import {
  approveAgentTurn,
  createAgentSession,
  deleteAgentSession,
  fetchAgentSession,
  fetchAgentSessions,
  fetchAgentSkills,
  isJobPending,
  newAgentTurnId,
  rejectAgentTurn,
  sendAgentMessage,
  setAgentSessionBudget,
  setAgentSkillOff,
  type AgentChatModel,
  type AgentSessionDetail,
  type AgentSessionSummary,
  type AgentSkill,
  type AgentTier,
  type AgentTurnBody,
} from "@/lib/client/agent";
import { fetchProducts, type Product } from "@/lib/client/models";
import { errorText } from "@/lib/i18n/errorText";
import AgentAsk, { type AskPop } from "./AgentAsk";
import AgentChat from "./AgentChat";
import AgentPlaza from "./AgentPlaza";
import { shot } from "./data";
import { IconPanelLeft, IconPencil, IconTrash } from "./icons";

/**
 * 历史抽屉里的一行：点标题打开，垃圾桶要二次确认（review 2026-09-15 U-18）。
 *
 * 删会话是不可撤销的——整条对话连同它的轮次记录一起没，而这个图标就贴在「打开」旁边
 * 十几个像素处。活动与归档两处共用同一行，所以抽出来。
 */
function SessionRow({
  session,
  archived,
  onOpen,
  onRemove,
}: {
  session: AgentSessionSummary;
  archived?: boolean;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      className="agent-drawer__row"
      data-session-id={session.id}
      data-archived={archived ? "true" : undefined}
    >
      {confirming ? (
        <div
          className="agent-drawer__confirm"
          role="alertdialog"
          aria-label={t("agent.deleteSession", { title: session.title })}
        >
          <span className="agent-drawer__confirm-text">{t("agent.deleteSession.confirmText")}</span>
          <button
            type="button"
            className="agent-drawer__confirm-btn"
            onClick={() => setConfirming(false)}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="agent-drawer__confirm-btn agent-drawer__confirm-btn--danger"
            onClick={() => {
              setConfirming(false);
              onRemove(session.id);
            }}
          >
            {t("agent.deleteSession.confirm")}
          </button>
        </div>
      ) : (
        <>
          <button type="button" className="agent-drawer__item" onClick={() => onOpen(session.id)}>
            <span className="agent-drawer__item-name">{session.title}</span>
          </button>
          <button
            type="button"
            className="agent-drawer__item-del"
            aria-label={t("agent.deleteSession", { title: session.title })}
            onClick={() => setConfirming(true)}
          >
            <IconTrash size={12} />
          </button>
        </>
      )}
    </div>
  );
}

type Screen = "home" | "plaza" | "chat";

/**
 * 旧版把技能开关存在这个 localStorage 键里。现在它是**账号级**服务端偏好，这个键只清不迁
 * （review 2026-09-15 C-20）：键名不含 userId，同一台浏览器上 A 用过旧版、B 登录且服务端
 * 偏好为空时，迁移会把 A 关掉的技能写进 B 的账号。
 */
const LEGACY_OFF_KEY = "genius.agent.skillsOff";
/** 会话里还有任务没跑完时，多久重拉一次详情。 */
const POLL_MS = 3000;

function offRecord(ids: string[]): Record<string, boolean> {
  return Object.fromEntries(ids.map((id) => [id, true]));
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
  const params = useSearchParams();
  const requestedSession = params.get("session");
  /** 创作面板的「创作搭子」把当前提示词带过来（`/agent?q=…`），只回填一次。 */
  const requestedPrompt = params.get("q");

  const [screen, setScreen] = useState<Screen>("home");
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [archivedSessions, setArchivedSessions] = useState<AgentSessionSummary[]>([]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [session, setSession] = useState<AgentSessionDetail | null>(null);

  const [prompt, setPrompt] = useState("");
  const [pop, setPop] = useState<AskPop>(null);
  const [tier, setTier] = useState<AgentTier>("balanced");
  const [chatModels, setChatModels] = useState<AgentChatModel[]>([]);
  const [chatDefault, setChatDefault] = useState<string | undefined>(undefined);
  const [chatModel, setChatModel] = useState<string | null>(null);
  const [imageProduct, setImageProduct] = useState<string | null>(null);
  const [videoProduct, setVideoProduct] = useState<string | null>(null);
  const [skillHover, setSkillHover] = useState(0);
  const [activeSkill, setActiveSkill] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [off, setOff] = useState<Record<string, boolean>>({});
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
  const openedDeepLink = useRef<string | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const say = useCallback(
    (e: unknown) => {
      if (alive.current) setError(errorText(t, e));
    },
    [t],
  );

  /* 旧键只清不迁（见 LEGACY_OFF_KEY 的说明）：留着它没有任何用处，迁移则会串账号。 */
  useEffect(() => {
    try {
      window.localStorage.removeItem(LEGACY_OFF_KEY);
    } catch {
      // 隐私模式下读写 localStorage 会抛；清不掉不影响任何功能。
    }
  }, []);

  useEffect(() => {
    fetchAgentSkills().then((res) => {
      if (!alive.current) return;
      setSkills(res.skills);
      setOff(offRecord(res.off));
      setAvailable(res.available);
      setChatModels(res.chat.models);
      setChatDefault(res.chat.default);
      setChatModel((current) => current ?? res.chat.default ?? null);
    }, say);
    // 产品拉不到不该让整页不可用：下拉退回只有「自动」一项，照样能创作。
    fetchProducts().then((list) => alive.current && setProducts(list), () => undefined);
    fetchAgentSessions().then(
      (list) => {
        if (!alive.current) return;
        setSessions(list);
        setSessionsLoaded(true);
      },
      say,
    );
  }, [say]);

  const toggleArchived = useCallback(() => {
    const opening = !archivedOpen;
    setArchivedOpen(opening);
    if (!opening || archivedLoaded) return;
    fetchAgentSessions({ archived: true }).then(
      (list) => {
        if (!alive.current) return;
        setArchivedSessions(list);
        setArchivedLoaded(true);
      },
      say,
    );
  }, [archivedLoaded, archivedOpen, say]);

  /* 会话里还有任务没跑完、或有轮次停在 thinking/executing 时才轮询；
     全终态就停下来，别对着一个不会变的东西每 3 秒问一次。 */
  const sessionId = session?.id ?? null;
  const pendingJobs = Boolean(session?.jobs.some(isJobPending));
  const activeTurns = Boolean(
    session?.turns.some((x) => x.status === "thinking" || x.status === "executing"),
  );
  useEffect(() => {
    if (!sessionId || (!pendingJobs && !activeTurns)) return;
    const timer = setInterval(() => {
      fetchAgentSession(sessionId).then((next) => {
        if (alive.current) setSession((cur) => (cur && cur.id === next.id ? next : cur));
      }, () => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [sessionId, pendingJobs, activeTurns]);

  /** 会话回来了就把芯片同步到它实际用的那一组（会话头记了模型 / 档位 / 产品）。 */
  const syncSession = useCallback((next: AgentSessionDetail) => {
    setSession(next);
    setChatModel(next.chatModel ?? chatDefault ?? null);
    setTier(next.tier ?? "balanced");
    setImageProduct(next.imageProduct ?? null);
    setVideoProduct(next.videoProduct ?? null);
  }, [chatDefault]);

  const turnBody = useCallback(
    (text: string): AgentTurnBody => ({
      text,
      ...(activeSkill ? { skillId: activeSkill } : {}),
      tier,
      ...(imageProduct ? { imageProduct } : {}),
      ...(videoProduct ? { videoProduct } : {}),
      ...(chatModel ? { chatModel } : {}),
      // 每次调用生成一个：同一句话被用户再发一次就是新的一轮（该再扣一次钱）；
      // 只有同一笔 HTTP 请求的透明重发才共享这个 id，被服务端按重放拦下。
      turnId: newAgentTurnId(),
    }),
    [activeSkill, tier, imageProduct, videoProduct, chatModel],
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
        syncSession(next);
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
    [available, busy, say, syncSession, turnBody],
  );

  const send = useCallback(
    async (text: string) => {
      if (!session || busy || !available) return;
      setError(null);
      setBusy(true);
      setPendingText(text);
      const wasArchived = Boolean(session.archivedAt);
      try {
        const next = await sendAgentMessage(session.id, turnBody(text));
        if (alive.current) syncSession(next);
        if (wasArchived) {
          Promise.all([fetchAgentSessions(), fetchAgentSessions({ archived: true })]).then(
            ([active, archived]) => {
              if (!alive.current) return;
              setSessions(active);
              setArchivedSessions(archived);
              setArchivedLoaded(true);
            },
            () => undefined,
          );
        }
      } catch (e) {
        say(e);
      } finally {
        if (alive.current) {
          setBusy(false);
          setPendingText(null);
        }
      }
    },
    [available, busy, say, session, syncSession, turnBody],
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
        if (alive.current) syncSession(next);
      } catch (e) {
        say(e);
        if (alive.current) setScreen("home");
      }
    },
    [say, syncSession],
  );

  /*
    带过来的提示词只回填一次：下面那条「把会话钉进地址栏」的 effect 会把 URL 换成
    `/agent`，`q` 随即消失——没有这道 ref，用户清空输入框后它还会被重新填回去。
  */
  const seededPrompt = useRef(false);
  useEffect(() => {
    if (seededPrompt.current || !requestedPrompt) return;
    seededPrompt.current = true;
    setPrompt(requestedPrompt.slice(0, 2000));
  }, [requestedPrompt]);

  // `(shell)` layout 明确 force-dynamic，useSearchParams 不触发静态预渲染的 Suspense 要求。
  useEffect(() => {
    if (!requestedSession || !sessionsLoaded || openedDeepLink.current === requestedSession) return;
    openedDeepLink.current = requestedSession;
    void open(requestedSession);
  }, [open, requestedSession, sessionsLoaded]);

  /*
    停在某条会话上就把它钉进地址栏（review 2026-09-15 U-10）：原来首屏发完一句后 URL 仍是
    `/agent`，手滑刷新就回到「一切，始于一个想法」，20 条气泡只能去历史抽屉里找回来。
    离开会话（返回首页、进技能广场、删除、新对话）要清掉，否则 URL 还指着 X，`requestedSession`
    不变、上面那条深链 effect 不重跑，点同一条会话的通知会毫无反应。

    先写 ref 再改地址栏：顺序反了，深链 effect 会把自己刚写的 `?session=` 当成新链接再跑一次
    `open()`，而 open 的第一步是清空会话，界面会闪一下空屏并多发一次请求。
    用 history.replaceState 而不是 router.replace：这里只换地址栏，不需要重新渲染路由树
    （与 `SubscriptionView` 处理 `#ledger` 同一写法）。
  */
  useEffect(() => {
    if (screen === "chat" && !sessionId) return; // 创建 / 读取在途，地址栏先别动
    const pinned = screen === "chat" ? sessionId : null;
    if (openedDeepLink.current === pinned) return;
    openedDeepLink.current = pinned;
    try {
      window.history.replaceState(
        null,
        "",
        pinned ? `/agent?session=${encodeURIComponent(pinned)}` : "/agent",
      );
    } catch {
      // 地址栏没同步不该让会话打不开。
    }
  }, [screen, sessionId]);

  /** 批准提案：批准那一刻才真的创建任务（B 包默认批准制）。 */
  const approve = useCallback(
    async (turnId: string) => {
      if (!session || busy) return;
      setError(null);
      setBusy(true);
      try {
        const next = await approveAgentTurn(session.id, turnId);
        if (alive.current) setSession(next);
      } catch (e) {
        say(e);
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [busy, say, session],
  );

  const reject = useCallback(
    async (turnId: string) => {
      if (!session || busy) return;
      setError(null);
      setBusy(true);
      try {
        const next = await rejectAgentTurn(session.id, turnId);
        if (alive.current) setSession(next);
      } catch (e) {
        say(e);
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [busy, say, session],
  );

  /** 设 / 解除会话预算（元）；非正数与 NaN 不入网。 */
  const setBudget = useCallback(
    async (cny: number | null) => {
      if (!session) return;
      if (cny !== null && (!Number.isFinite(cny) || cny <= 0)) {
        say(new Error(t("agent.budgetSet")));
        return;
      }
      try {
        const next = await setAgentSessionBudget(session.id, cny);
        if (alive.current) setSession(next);
      } catch (e) {
        say(e);
      }
    },
    [say, session, t],
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
      setArchivedSessions((list) => list.filter((s) => s.id !== id));
      setSession((cur) => (cur?.id === id ? null : cur));
      setScreen((cur) => (cur === "chat" ? "home" : cur));
    },
    [say],
  );

  const toggleSkill = useCallback(
    (id: string) => {
      const wasOff = Boolean(off[id]);
      const nextOff = !wasOff;
      setOff((current) => ({ ...current, [id]: nextOff }));
      void setAgentSkillOff(id, nextOff).then(
        (stored) => {
          if (alive.current) setOff(offRecord(stored));
        },
        (error: unknown) => {
          if (!alive.current) return;
          setOff((current) => ({ ...current, [id]: wasOff }));
          say(error);
        },
      );
    },
    [off, say],
  );

  const enabled = skills.filter((s) => !off[s.id]);

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
                chatModels={chatModels}
                chatDefault={chatDefault}
                chatModel={chatModel}
                onChatModel={setChatModel}
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
                  <SessionRow key={s.id} session={s} onOpen={(id) => void open(id)} onRemove={(id) => void remove(id)} />
                ))
              )}
              <button
                type="button"
                className="agent-history__archived-toggle"
                aria-expanded={archivedOpen}
                onClick={toggleArchived}
              >
                {t("agent.history.archived")}
              </button>
              {archivedOpen && archivedLoaded ? (
                archivedSessions.length === 0 ? (
                  <p className="agent-drawer__empty">{t("agent.history.archivedEmpty")}</p>
                ) : (
                  archivedSessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      archived
                      onOpen={(id) => void open(id)}
                      onRemove={(id) => void remove(id)}
                    />
                  ))
                )
              ) : null}
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
          chatModels={chatModels}
          chatDefault={chatDefault}
          chatModel={chatModel}
          onChatModel={setChatModel}
          tier={tier}
          onTier={setTier}
          imageProduct={imageProduct}
          onImageProduct={setImageProduct}
          videoProduct={videoProduct}
          onVideoProduct={setVideoProduct}
          products={products}
          skillHover={skillHover}
          onSkillHover={setSkillHover}
          activeSkill={activeSkill}
          onActiveSkill={setActiveSkill}
          onManageSkills={() => setScreen("plaza")}
          onSend={(text) => void send(text)}
          onBack={() => {
            setScreen("home");
            setError(null);
          }}
          onDelete={() => (session ? void remove(session.id) : undefined)}
          onApprove={(turnId) => void approve(turnId)}
          onReject={(turnId) => void reject(turnId)}
          onBudget={(cny) => void setBudget(cny)}
        />
      ) : null}
    </div>
  );
}
