"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createRelay,
  discoverRelay,
  listRelays,
  probeRelay,
  removeRelay,
  updateRelay,
  type RelayCatalogModel,
  type RelayCreateInput,
  type RelayEntry,
  type RelayModelPatch,
} from "@/lib/client/relays";
import { ApiError } from "@/lib/client/http";
import { useT } from "@/components/genius/i18n/I18nProvider";
import { errorText } from "@/lib/i18n/errorText";
import type { MessageKey } from "@/lib/i18n/messages";

/*
  中转管理页 `/admin/relays`（N3.5，方案 plan-relay-provider §4b）。

  只管理 `data/relays.json` 里的显式条目：env 折算的 yman / openai 预设（`managed=false`）
  全部只读——PATCH/DELETE 它们服务端本来就 404，界面把开关、排序、删除直接禁用，
  并用一行提示指到 `.env`。discover / probe 对所有条目开放（它们是只读性质的操作，
  probe 会向上游发真实请求，先弹「可能计费」确认）。

  DOM 契约：`section.relay-card[data-card]`；每条 relay 一行 `.relay-row[data-relay-id]`；
  健康灯 `.relay-admin__health[data-health]`；hasKey 灯 `.relay-admin__keylamp[data-has]`；
  新建表单 `.relay-admin__create`。403/404 → 显示「无权限」并停止后续动作；
  401 由 `parseAuthed` 整页跳登录。
*/

/** 每行在途操作的标记（同一行并发操作会让 priority 交换写乱）。 */
type RowBusy = Record<string, boolean>;

/** 月-日 时:分（与 TopBar 的 clock 同格式；快照时间只需粗粒度）。 */
function clock(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const HEALTH_KEY: Record<string, MessageKey> = {
  ok: "admin.relays.health.ok",
  cooldown: "admin.relays.health.cooldown",
  "half-open": "admin.relays.health.halfOpen",
};

const SOURCE_KEY: Record<RelayEntry["source"], MessageKey> = {
  file: "admin.relays.source.file",
  "env-seed": "admin.relays.source.envSeed",
  legacy: "admin.relays.source.legacy",
};

/** 新建表单的本地 state；通道块按需展开（image/chat 需要各自的模型名）。 */
type FormState = {
  id: string;
  name: string;
  baseUrl: string;
  keyEnv: string;
  priority: string;
  video: boolean;
  image: boolean;
  imageModel: string;
  chat: boolean;
  chatModel: string;
  catalogSource: "" | "static" | "models-endpoint";
};

const EMPTY_FORM: FormState = {
  id: "",
  name: "",
  baseUrl: "",
  keyEnv: "",
  priority: "0",
  video: true,
  image: false,
  imageModel: "",
  chat: false,
  chatModel: "",
  catalogSource: "",
};

/** 模型表一行的编辑草稿：数值字段保持字符串，保存时才解析（空 = 不覆盖）。 */
type ModelDraft = {
  kind: "video" | "image" | "chat";
  name: string;
  hidden: boolean;
  v5: string;
  v10: string;
  hd: string;
  audio: string;
  i1k: string;
  i2k: string;
  maxRefs: string;
  durations: string;
};

const numStr = (n: number | undefined): string => (n == null ? "" : String(n));

function draftOf(m: RelayCatalogModel): ModelDraft {
  return {
    kind: m.kind ?? "video",
    name: m.name ?? "",
    hidden: m.hidden === true,
    v5: numStr(m.price?.video?.["5"]),
    v10: numStr(m.price?.video?.["10"]),
    hd: numStr(m.price?.video?.hd),
    audio: numStr(m.price?.video?.audio),
    i1k: numStr(m.price?.image?.["1k"]),
    i2k: numStr(m.price?.image?.["2k"]),
    maxRefs: String(m.maxReferenceImages),
    durations: m.durations.join(","),
  };
}

/** 草稿 → 数字价覆盖；全是空串返回 undefined（不定价）。 */
function priceOf(draft: ModelDraft): RelayModelPatch["price"] {
  const num = (s: string) => {
    const n = Number(s);
    return s.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const video = { "5": num(draft.v5), "10": num(draft.v10), hd: num(draft.hd), audio: num(draft.audio) };
  const image = { "1k": num(draft.i1k), "2k": num(draft.i2k) };
  const hasVideo = Object.values(video).some((v) => v !== undefined);
  const hasImage = Object.values(image).some((v) => v !== undefined);
  return hasVideo || hasImage
    ? { video: hasVideo ? video : undefined, image: hasImage ? image : undefined }
    : undefined;
}

/**
 * 草稿 → PATCH 的模型覆盖。服务端对 `catalog.models[key]` 是**整键替换**，
 * 所以改任何字段都要带上完整的一份（UI 不编辑的 resolutions / ratios 从
 * 合并视图原样抄回），否则会把同模型没改的配置抹掉。草稿与下发视图全同返回
 * null（未改，不进 PATCH）。
 */
function draftToPatch(draft: ModelDraft, m: RelayCatalogModel): RelayModelPatch | null {
  const base = draftOf(m);
  const durations = draft.durations
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const maxRefs = Number(draft.maxRefs);
  const spec: RelayModelPatch = {
    kind: draft.kind,
    hidden: draft.hidden,
    price: priceOf(draft),
    durations: durations.length ? durations : m.durations,
    resolutions: m.resolutions as RelayModelPatch["resolutions"],
    ratios: m.ratios,
    maxReferenceImages:
      Number.isFinite(maxRefs) && maxRefs >= 0 ? Math.floor(maxRefs) : m.maxReferenceImages,
  };
  if (draft.name.trim()) spec.name = draft.name.trim();
  const dirty =
    draft.kind !== base.kind ||
    draft.name !== base.name ||
    draft.hidden !== base.hidden ||
    JSON.stringify(priceOf(draft) ?? null) !== JSON.stringify(priceOf(base) ?? null) ||
    draft.durations !== base.durations ||
    draft.maxRefs !== base.maxRefs;
  return dirty ? spec : null;
}

function formToBody(form: FormState): RelayCreateInput {
  const body: RelayCreateInput = {
    id: form.id.trim(),
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    keyEnv: form.keyEnv.trim(),
    enabled: true,
    priority: Number(form.priority) || 0,
  };
  if (form.video) body.video = { protocol: "openai-videos", defaults: {} };
  if (form.image) {
    body.image = { protocol: "openai-images", model: form.imageModel.trim() };
  }
  if (form.chat) body.chat = { model: form.chatModel.trim() };
  if (form.catalogSource) body.catalog = { source: form.catalogSource, models: {} };
  return body;
}

export function RelayAdmin() {
  const t = useT();
  const [relays, setRelays] = useState<RelayEntry[] | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const [rowBusy, setRowBusy] = useState<RowBusy>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [modelsOpen, setModelsOpen] = useState<Record<string, boolean>>({});
  const [modelDrafts, setModelDrafts] = useState<Record<string, Record<string, ModelDraft>>>({});

  /* 403/404 = 权限丧失（或会话降级）：显示「无权限」并停在那里，不再重试。 */
  const refresh = useCallback(async () => {
    try {
      const list = await listRelays();
      setRelays([...list].sort((a, b) => a.priority - b.priority));
    } catch (e) {
      // 403/404 = 权限丧失：固定显示「无权限」而不是服务端 message。
      setFatal(
        e instanceof ApiError && (e.status === 403 || e.status === 404)
          ? t("admin.relays.forbidden")
          : errorText(t, e),
      );
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setBusy = useCallback((id: string, on: boolean) => {
    setRowBusy((prev) => ({ ...prev, [id]: on }));
  }, []);

  /** 行内动作的公共收尾：错误写行内，成功清行内错并刷新列表。 */
  const runRow = useCallback(
    async (id: string, action: () => Promise<string | void>) => {
      setBusy(id, true);
      setRowErr((prev) => ({ ...prev, [id]: "" }));
      try {
        const note = await action();
        if (note) setResults((prev) => ({ ...prev, [id]: note }));
        await refresh();
      } catch (e) {
        setRowErr((prev) => ({ ...prev, [id]: errorText(t, e) }));
      } finally {
        setBusy(id, false);
      }
    },
    [refresh, setBusy, t],
  );

  const toggle = useCallback(
    (relay: RelayEntry) =>
      runRow(relay.id, async () => {
        await updateRelay(relay.id, { enabled: !relay.enabled });
      }),
    [runRow],
  );

  /** 上移/下移 = 与相邻行交换 priority（两次 PATCH，按钮而非拖拽——有意偏离，见 DESIGN）。 */
  const move = useCallback(
    (relay: RelayEntry, neighbor: RelayEntry) =>
      runRow(relay.id, async () => {
        await updateRelay(relay.id, { priority: neighbor.priority });
        await updateRelay(neighbor.id, { priority: relay.priority });
      }),
    [runRow],
  );

  const discover = useCallback(
    (relay: RelayEntry) =>
      runRow(relay.id, async () => {
        const r = await discoverRelay(relay.id);
        return t("admin.relays.discover.result", {
          n: r.models.length,
          added: r.diff.added.length,
          removed: r.diff.removed.length,
        });
      }),
    [runRow, t],
  );

  const probe = useCallback(
    (relay: RelayEntry) => {
      if (!window.confirm(t("admin.relays.probeConfirm", { name: relay.name }))) return;
      void runRow(relay.id, async () => {
        const r = await probeRelay(relay.id);
        return t("admin.relays.probe.result", {
          status: r.status,
          ms: r.ms,
          detail: r.detail,
        });
      });
    },
    [runRow, t],
  );

  const remove = useCallback(
    (relay: RelayEntry) => {
      if (!window.confirm(t("admin.relays.deleteConfirm", { name: relay.name }))) return;
      void runRow(relay.id, async () => {
        await removeRelay(relay.id);
      });
    },
    [runRow, t],
  );

  /** 模型表草稿：未碰过的行回落服务端下发的合并视图。 */
  const draftFor = useCallback(
    (relay: RelayEntry, m: RelayCatalogModel): ModelDraft =>
      modelDrafts[relay.id]?.[m.id] ?? draftOf(m),
    [modelDrafts],
  );

  const setDraft = useCallback((relayId: string, modelId: string, draft: ModelDraft) => {
    setModelDrafts((prev) => ({
      ...prev,
      [relayId]: { ...prev[relayId], [modelId]: draft },
    }));
  }, []);

  /** 底部「保存」：只 PATCH 改过的模型（draftToPatch 返回 null 的行不进请求体）。 */
  const saveModels = useCallback(
    (relay: RelayEntry) =>
      runRow(relay.id, async () => {
        const models: Record<string, RelayModelPatch> = {};
        for (const m of relay.catalog?.models ?? []) {
          const draft = modelDrafts[relay.id]?.[m.id];
          if (!draft) continue;
          const patch = draftToPatch(draft, m);
          if (patch) models[m.id] = patch;
        }
        if (!Object.keys(models).length) return;
        await updateRelay(relay.id, { catalog: { models } });
        setModelDrafts((prev) => ({ ...prev, [relay.id]: {} }));
        return t("admin.relays.models.saved");
      }),
    [modelDrafts, runRow, t],
  );

  /** 行尾「还原覆盖」：PATCH 该模型传 null，删掉配置覆盖（快照模型仍留在目录里）。 */
  const resetModel = useCallback(
    (relay: RelayEntry, modelId: string) =>
      runRow(relay.id, async () => {
        await updateRelay(relay.id, { catalog: { models: { [modelId]: null } } });
        setModelDrafts((prev) => {
          const next = { ...(prev[relay.id] ?? {}) };
          delete next[modelId];
          return { ...prev, [relay.id]: next };
        });
      }),
    [runRow],
  );

  /** env 预设 → 文件条目：把视图给出的通道底稿（默认模型 / 生图模型）落成显式配置。 */
  const promote = useCallback(
    (relay: RelayEntry) =>
      runRow(relay.id, async () => {
        const cat = relay.catalog;
        const body: RelayCreateInput = {
          id: relay.id,
          name: relay.name,
          baseUrl: relay.baseUrl,
          keyEnv: relay.keyEnv,
          enabled: relay.enabled,
          priority: relay.priority,
        };
        if (relay.channels.video) {
          const defaults = Object.fromEntries(
            Object.entries(cat?.videoDefaults ?? {}).filter(
              ([, v]) => typeof v === "string" && v.trim(),
            ),
          ) as Record<string, string>;
          body.video = { protocol: "openai-videos", defaults };
        }
        if (relay.channels.image) {
          body.image = { protocol: "openai-images", model: cat?.imageModel ?? "" };
        }
        if (relay.catalogSource) {
          body.catalog = { source: "models-endpoint", models: {} };
        }
        await createRelay(body);
        return t("admin.relays.models.promoted");
      }),
    [runRow, t],
  );

  const submitCreate = useCallback(() => {
    if (creating) return;
    setCreating(true);
    setCreateErr(null);
    void createRelay(formToBody(form))
      .then(async () => {
        setForm(EMPTY_FORM);
        setCreateOpen(false);
        await refresh();
      })
      .catch((e: unknown) => {
        // zod 的校验细节在 `error.message` 里（invalid_argument 会拼上原文）。
        setCreateErr(errorText(t, e));
      })
      .finally(() => setCreating(false));
  }, [creating, form, refresh, t]);

  const sorted = useMemo(() => relays ?? [], [relays]);

  return (
    <div className="relay-admin">
      <div className="relay-admin__body">
        <section className="relay-card" data-card="head">
          <div className="account-card__head">
            <span className="account-card__title">{t("admin.relays.title")}</span>
            <button
              type="button"
              className="account-card__link account-card__link--end"
              onClick={() => setCreateOpen((v) => !v)}
              aria-expanded={createOpen}
            >
              {t("admin.relays.create")}
            </button>
          </div>
          <p className="account-note">{t("admin.relays.hint")}</p>
        </section>

        {createOpen ? (
          <section className="relay-card relay-admin__create" data-card="create">
            <div className="relay-admin__form">
              <label className="relay-admin__field">
                <span className="relay-admin__label">id</span>
                <input
                  className="relay-admin__input"
                  name="id"
                  value={form.id}
                  onChange={(e) => setForm({ ...form, id: e.target.value })}
                  placeholder="my-relay"
                />
              </label>
              <label className="relay-admin__field">
                <span className="relay-admin__label">{t("admin.relays.form.name")}</span>
                <input
                  className="relay-admin__input"
                  name="name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label className="relay-admin__field">
                <span className="relay-admin__label">baseUrl</span>
                <input
                  className="relay-admin__input"
                  name="baseUrl"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  placeholder="https://example.com/v1"
                />
              </label>
              <label className="relay-admin__field">
                <span className="relay-admin__label">keyEnv</span>
                <input
                  className="relay-admin__input"
                  name="keyEnv"
                  value={form.keyEnv}
                  onChange={(e) => setForm({ ...form, keyEnv: e.target.value })}
                  placeholder="MY_RELAY_API_KEY"
                />
              </label>
              <label className="relay-admin__field relay-admin__field--num">
                <span className="relay-admin__label">{t("admin.relays.form.priority")}</span>
                <input
                  className="relay-admin__input"
                  name="priority"
                  inputMode="numeric"
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                />
              </label>
              <div className="relay-admin__field">
                <span className="relay-admin__label">{t("admin.relays.form.channels")}</span>
                <div className="relay-admin__checks">
                  {(["video", "image", "chat"] as const).map((ch) => (
                    <label key={ch} className="relay-admin__check">
                      <input
                        type="checkbox"
                        name={`channel-${ch}`}
                        checked={form[ch]}
                        onChange={(e) => setForm({ ...form, [ch]: e.target.checked })}
                      />
                      {t(`admin.relays.channel.${ch}`)}
                    </label>
                  ))}
                </div>
              </div>
              {form.image ? (
                <label className="relay-admin__field">
                  <span className="relay-admin__label">{t("admin.relays.form.imageModel")}</span>
                  <input
                    className="relay-admin__input"
                    name="imageModel"
                    value={form.imageModel}
                    onChange={(e) => setForm({ ...form, imageModel: e.target.value })}
                    placeholder="gpt-image-1"
                  />
                </label>
              ) : null}
              {form.chat ? (
                <label className="relay-admin__field">
                  <span className="relay-admin__label">{t("admin.relays.form.chatModel")}</span>
                  <input
                    className="relay-admin__input"
                    name="chatModel"
                    value={form.chatModel}
                    onChange={(e) => setForm({ ...form, chatModel: e.target.value })}
                  />
                </label>
              ) : null}
              <label className="relay-admin__field">
                <span className="relay-admin__label">{t("admin.relays.form.catalogSource")}</span>
                <select
                  className="relay-admin__input"
                  name="catalogSource"
                  value={form.catalogSource}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      catalogSource: e.target.value as FormState["catalogSource"],
                    })
                  }
                >
                  <option value="">{t("admin.relays.catalog.none")}</option>
                  <option value="static">static</option>
                  <option value="models-endpoint">models-endpoint</option>
                </select>
              </label>
            </div>
            {createErr ? (
              <p className="relay-admin__err" role="alert">
                {createErr}
              </p>
            ) : null}
            <div className="account-actions">
              <button
                type="button"
                className="account-btn"
                onClick={() => setCreateOpen(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="account-btn relay-admin__submit"
                disabled={creating}
                onClick={submitCreate}
              >
                {creating ? t("admin.relays.creating") : t("admin.relays.createSubmit")}
              </button>
            </div>
          </section>
        ) : null}

        <section className="relay-card" data-card="list">
          {fatal ? (
            <p className="relay-admin__fatal" role="alert">
              {fatal}
            </p>
          ) : relays === null ? (
            <p className="relay-admin__loading">{t("admin.relays.loading")}</p>
          ) : sorted.length === 0 ? (
            <p className="relay-admin__loading">{t("admin.relays.empty")}</p>
          ) : (
            sorted.map((relay, index) => {
              const busy = !!rowBusy[relay.id];
              const above = sorted[index - 1];
              const below = sorted[index + 1];
              const canMoveUp = relay.managed && !!above?.managed;
              const canMoveDown = relay.managed && !!below?.managed;
              return (
                <div
                  key={relay.id}
                  className="relay-row"
                  data-relay-id={relay.id}
                  data-managed={relay.managed}
                  data-enabled={relay.enabled}
                >
                  <div className="relay-row__head">
                    <span className="relay-row__name">{relay.name}</span>
                    <span className="relay-row__id">{relay.id}</span>
                    <span className="relay-row__source" data-source={relay.source}>
                      {t(SOURCE_KEY[relay.source])}
                    </span>
                    {!relay.managed ? (
                      <span className="relay-row__env">{t("admin.relays.envManaged")}</span>
                    ) : null}
                  </div>
                  <div className="relay-row__meta">
                    <span className="relay-row__url">{relay.baseUrl}</span>
                    <span className="relay-row__key">
                      <code>{relay.keyEnv}</code>
                      <span
                        className="relay-admin__keylamp"
                        data-has={relay.hasKey}
                        title={
                          relay.hasKey
                            ? t("admin.relays.key.has")
                            : t("admin.relays.key.missing")
                        }
                      />
                      {relay.hasKey ? t("admin.relays.key.has") : t("admin.relays.key.missing")}
                    </span>
                  </div>
                  <div className="relay-row__facts">
                    <span className="relay-row__chips">
                      {(["video", "image", "chat"] as const)
                        .filter((ch) => relay.channels[ch])
                        .map((ch) => (
                          <span key={ch} className="relay-admin__chip" data-channel={ch}>
                            {t(`admin.relays.channel.${ch}`)}
                          </span>
                        ))}
                    </span>
                    <span className="relay-row__health">
                      {(["video", "image"] as const)
                        .filter((kind) => relay.health[kind])
                        .map((kind) => {
                          const state = relay.health[kind]!;
                          return (
                            <span
                              key={kind}
                              className="relay-admin__health"
                              data-health={state}
                            >
                              {t(`admin.relays.channel.${kind}`)}·{t(HEALTH_KEY[state])}
                            </span>
                          );
                        })}
                    </span>
                    <span className="relay-row__catalog">
                      {relay.catalogSource
                        ? `${relay.catalogSource} · ${t("admin.relays.catalog.snapshot")} ${clock(relay.catalogSnapshotAt)}`
                        : t("admin.relays.catalog.none")}
                    </span>
                  </div>
                  <div className="relay-row__actions">
                    <button
                      type="button"
                      className="relay-admin__toggle"
                      data-on={relay.enabled}
                      disabled={!relay.managed || busy}
                      title={relay.managed ? undefined : t("admin.relays.managedOnly")}
                      onClick={() => toggle(relay)}
                    >
                      {relay.enabled ? t("admin.relays.enabled") : t("admin.relays.disabled")}
                    </button>
                    <button
                      type="button"
                      className="relay-admin__btn"
                      disabled={!canMoveUp || busy}
                      title={canMoveUp ? undefined : t("admin.relays.managedOnly")}
                      aria-label={t("admin.relays.up")}
                      onClick={() => above && move(relay, above)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="relay-admin__btn"
                      disabled={!canMoveDown || busy}
                      title={canMoveDown ? undefined : t("admin.relays.managedOnly")}
                      aria-label={t("admin.relays.down")}
                      onClick={() => below && move(relay, below)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="relay-admin__btn"
                      disabled={busy}
                      onClick={() => discover(relay)}
                    >
                      {t("admin.relays.discover")}
                    </button>
                    <button
                      type="button"
                      className="relay-admin__btn"
                      disabled={busy}
                      onClick={() => probe(relay)}
                    >
                      {t("admin.relays.probe")}
                    </button>
                    {relay.catalog ? (
                      <button
                        type="button"
                        className="relay-admin__btn"
                        disabled={busy}
                        aria-expanded={!!modelsOpen[relay.id]}
                        onClick={() =>
                          setModelsOpen((prev) => ({ ...prev, [relay.id]: !prev[relay.id] }))
                        }
                      >
                        {t("admin.relays.models.toggle")}
                      </button>
                    ) : null}
                    {!relay.managed ? (
                      <button
                        type="button"
                        className="relay-admin__btn"
                        disabled={busy}
                        onClick={() => promote(relay)}
                      >
                        {t("admin.relays.models.promote")}
                      </button>
                    ) : null}
                    {relay.managed ? (
                      <button
                        type="button"
                        className="relay-admin__btn relay-admin__btn--danger"
                        disabled={busy}
                        onClick={() => remove(relay)}
                      >
                        {t("admin.relays.delete")}
                      </button>
                    ) : null}
                  </div>
                  {results[relay.id] ? (
                    <p className="relay-row__result">{results[relay.id]}</p>
                  ) : null}
                  {rowErr[relay.id] ? (
                    <p className="relay-admin__err" role="alert">
                      {rowErr[relay.id]}
                    </p>
                  ) : null}
                  {modelsOpen[relay.id] && relay.catalog ? (
                    <div className="relay-models" data-relay-id={relay.id}>
                      <div className="relay-models__scroll">
                        <div className="relay-models__row relay-models__row--head">
                          <span>{t("admin.relays.models.col.id")}</span>
                          <span>{t("admin.relays.models.col.kind")}</span>
                          <span>{t("admin.relays.models.col.name")}</span>
                          <span>{t("admin.relays.models.col.hidden")}</span>
                          <span>{t("admin.relays.models.col.price")}</span>
                          <span>{t("admin.relays.models.col.refs")}</span>
                          <span>{t("admin.relays.models.col.durations")}</span>
                          <span>{t("admin.relays.models.col.status")}</span>
                        </div>
                        {relay.catalog.models.length === 0 ? (
                          <p className="relay-models__empty">
                            {t("admin.relays.models.empty")}
                          </p>
                        ) : (
                          relay.catalog.models.map((m) => {
                            const draft = draftFor(relay, m);
                            const editable = relay.managed;
                            const priced =
                              draft.kind === "image"
                                ? draft.i1k.trim() !== ""
                                : draft.v5.trim() !== "" && draft.v10.trim() !== "";
                            const badge = draft.hidden
                              ? "admin.relays.models.badge.hidden"
                              : m.defaultPinned
                                ? "admin.relays.models.badge.pinned"
                                : draft.kind === "chat"
                                  ? "admin.relays.models.badge.chat"
                                  : !priced
                                    ? "admin.relays.models.badge.unpriced"
                                    : m.listed
                                      ? "admin.relays.models.badge.listed"
                                      : "admin.relays.models.badge.unpriced";
                            type PriceField = Extract<
                              keyof ModelDraft,
                              "v5" | "v10" | "hd" | "audio" | "i1k" | "i2k"
                            >;
                            const priceFields: [PriceField, MessageKey][] =
                              draft.kind === "image"
                                ? [
                                    ["i1k", "admin.relays.models.price.1k"],
                                    ["i2k", "admin.relays.models.price.2k"],
                                  ]
                                : draft.kind === "chat"
                                  ? []
                                  : [
                                      ["v5", "admin.relays.models.price.5"],
                                      ["v10", "admin.relays.models.price.10"],
                                      ["hd", "admin.relays.models.price.hd"],
                                      ["audio", "admin.relays.models.price.audio"],
                                    ];
                            return (
                              <div
                                key={m.id}
                                className="relay-models__row"
                                data-model-id={m.id}
                                data-listed={m.listed}
                              >
                                <span className="relay-models__id" title={m.id}>
                                  {m.id}
                                </span>
                                <select
                                  className="relay-models__input"
                                  value={draft.kind}
                                  disabled={!editable || busy}
                                  onChange={(e) =>
                                    setDraft(relay.id, m.id, {
                                      ...draft,
                                      kind: e.target.value as ModelDraft["kind"],
                                    })
                                  }
                                >
                                  <option value="video">video</option>
                                  <option value="image">image</option>
                                  <option value="chat">chat</option>
                                </select>
                                <input
                                  className="relay-models__input"
                                  value={draft.name}
                                  disabled={!editable || busy}
                                  placeholder={m.upstreamName ?? m.id}
                                  onChange={(e) =>
                                    setDraft(relay.id, m.id, { ...draft, name: e.target.value })
                                  }
                                />
                                <input
                                  type="checkbox"
                                  className="relay-models__check"
                                  checked={draft.hidden}
                                  disabled={!editable || busy}
                                  onChange={(e) =>
                                    setDraft(relay.id, m.id, {
                                      ...draft,
                                      hidden: e.target.checked,
                                    })
                                  }
                                />
                                <span className="relay-models__prices">
                                  {priceFields.map(([field, key]) => (
                                    <label key={field} className="relay-models__price">
                                      <span>{t(key)}</span>
                                      <input
                                        className="relay-models__num"
                                        inputMode="decimal"
                                        value={draft[field]}
                                        disabled={!editable || busy}
                                        onChange={(e) =>
                                          setDraft(relay.id, m.id, {
                                            ...draft,
                                            [field]: e.target.value,
                                          })
                                        }
                                      />
                                    </label>
                                  ))}
                                </span>
                                <input
                                  className="relay-models__num"
                                  inputMode="numeric"
                                  value={draft.maxRefs}
                                  disabled={!editable || busy}
                                  onChange={(e) =>
                                    setDraft(relay.id, m.id, {
                                      ...draft,
                                      maxRefs: e.target.value,
                                    })
                                  }
                                />
                                <input
                                  className="relay-models__input"
                                  value={draft.durations}
                                  disabled={!editable || busy}
                                  placeholder="5,10"
                                  onChange={(e) =>
                                    setDraft(relay.id, m.id, {
                                      ...draft,
                                      durations: e.target.value,
                                    })
                                  }
                                />
                                <span className="relay-models__badge" data-badge={badge.split(".").pop()}>
                                  {t(badge as MessageKey)}
                                  {m.fromConfig && editable ? (
                                    <button
                                      type="button"
                                      className="relay-models__reset"
                                      disabled={busy}
                                      onClick={() => resetModel(relay, m.id)}
                                    >
                                      {t("admin.relays.models.reset")}
                                    </button>
                                  ) : null}
                                </span>
                              </div>
                            );
                          })
                        )}
                      </div>
                      {relay.managed ? (
                        <div className="relay-models__foot">
                          <button
                            type="button"
                            className="relay-admin__btn relay-admin__submit"
                            disabled={busy}
                            onClick={() => saveModels(relay)}
                          >
                            {t("admin.relays.models.save")}
                          </button>
                        </div>
                      ) : (
                        <p className="relay-models__empty">
                          {t("admin.relays.models.readonly")}
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </section>
      </div>
    </div>
  );
}
