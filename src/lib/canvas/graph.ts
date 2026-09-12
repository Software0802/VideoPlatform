import { createHash } from "node:crypto";
import { priceCny } from "@/lib/billing/prices";
import { stableJsonHash } from "@/lib/jobs/idempotency";
import {
  modelForProvider,
  providerSettingsFor,
} from "@/lib/jobs/provider-settings";
import { chooseProduct, labelProduct } from "@/lib/jobs/product-choice";
import { readUploadSidecar } from "@/lib/jobs/upload";
import type { CreateJobBody } from "@/lib/jobs/schema";
import { ProviderHttpError } from "@/lib/providers/types";
import type { NativeMode } from "@/lib/providers/types";
import type {
  CanvasDocument,
  CanvasNode,
  CanvasQuote,
  CanvasQuoteItem,
} from "@/lib/canvas/schema";

/**
 * 画布图校验与报价（D 包）。
 *
 * 「整张图跑一次」在付费前只做静态校验：环、容量、提示词来源、素材归属。
 * 生成节点之间的输入一律解析自**本轮** `nodeExecutions`——上游 gen_image 不要求
 * 已有 jobId（新画布首次运行正是主场景），也不引用历史任务产物；改图 = 新 run。
 *
 * 报价 = 「只算不建」：与 `createJob` 共用 `chooseProduct` + `providerSettingsFor`
 * + `priceCny` 的归一管线，保证「报的价 = 会扣的价」（可灵 8s→10s 这类归一必须
 * 体现在报价里）。报价不落盘——它是（文档 revision + 归一参数 + 价目表）的确定
 * 性函数，创建 run 时重算比对 hash。
 */

/** 计划建议的初版容量上限（plan §5.1）。 */
export const CANVAS_MAX_NODES = 50;
export const CANVAS_MAX_EDGES = 100;

export type Graph = Pick<CanvasDocument, "nodes" | "edges">;

export function isGenNode(node: CanvasNode): boolean {
  return node.kind === "gen_image" || node.kind === "gen_video";
}

/** 连入 `nodeId` 的节点（画布顺序）。 */
export function nodeInputs(graph: Graph, nodeId: string): CanvasNode[] {
  const from = new Set(graph.edges.filter((e) => e.to === nodeId).map((e) => e.from));
  return graph.nodes.filter((n) => from.has(n.id));
}

/** 该节点的「生成上游」——只有 gen 节点构成执行依赖；text/material 是静态输入。 */
export function genDeps(graph: Graph, nodeId: string): CanvasNode[] {
  return nodeInputs(graph, nodeId).filter(isGenNode);
}

/** 提示词 = 连入 text 节点内容（画布顺序）+ 节点自身 prompt。与 `run.ts` 同口径。 */
export function mergePrompt(graph: Graph, node: CanvasNode): string {
  const parts = [
    ...nodeInputs(graph, node.id)
      .filter((n) => n.kind === "text" && n.text?.trim())
      .map((n) => n.text!.trim()),
    node.prompt?.trim() ?? "",
  ].filter(Boolean);
  return parts.join("\n");
}

/**
 * 该节点这次会按哪种 mode 下单：`gen_video` 有图片来源（material 或 gen_image
 * 入边）即 `image_to_video`，否则 `text_to_video`；`gen_image` 恒 `text_to_image`。
 * 报价与执行器都用它，口径才不会在「上游图还没产出」时飘移。
 */
export function nodeMode(graph: Graph, node: CanvasNode): Extract<
  NativeMode,
  "text_to_image" | "text_to_video" | "image_to_video"
> {
  if (node.kind === "gen_image") return "text_to_image";
  const hasImageInput = nodeInputs(graph, node.id).some(
    (n) => n.kind === "material" || n.kind === "gen_image",
  );
  return hasImageInput ? "image_to_video" : "text_to_video";
}

/** 拓扑序（Kahn）：有环返回 null。依赖边只看 gen→gen，静态输入节点排最前。 */
export function topoOrder(graph: Graph): CanvasNode[] | null {
  const indegree = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const n of graph.nodes) indegree.set(n.id, 0);
  for (const e of graph.edges) {
    if (!indegree.has(e.from) || !indegree.has(e.to)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  }
  const queue = graph.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: CanvasNode[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  while (queue.length) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (node) order.push(node);
    for (const next of out.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return order.length === graph.nodes.length ? order : null;
}

/**
 * 静态校验：任一不满足即 400/404，不产生任何付费提交。
 * 素材校验是「只读不消耗」——`readUploadSidecar` 不 move 文件。
 */
export async function validateGraph(graph: Graph, ownerId: string): Promise<void> {
  if (graph.nodes.length > CANVAS_MAX_NODES || graph.edges.length > CANVAS_MAX_EDGES) {
    throw new ProviderHttpError(
      400,
      "invalid_argument",
      `画布超出上限（节点 ${CANVAS_MAX_NODES} / 边 ${CANVAS_MAX_EDGES}）`,
    );
  }
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (ids.size !== graph.nodes.length) {
    throw new ProviderHttpError(400, "invalid_argument", "画布里有重复节点");
  }
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      throw new ProviderHttpError(400, "invalid_argument", "连线指向不存在的节点");
    }
  }
  if (!topoOrder(graph)) {
    throw new ProviderHttpError(400, "invalid_argument", "画布连线存在环，无法运行");
  }
  const gens = graph.nodes.filter(isGenNode);
  if (!gens.length) {
    throw new ProviderHttpError(400, "invalid_argument", "画布上没有可运行的生成节点");
  }
  for (const node of gens) {
    if (!mergePrompt(graph, node)) {
      throw new ProviderHttpError(
        400,
        "invalid_argument",
        "生成节点需要提示词（节点自身或连入的文本节点）",
      );
    }
  }
  for (const node of graph.nodes) {
    if (node.kind === "material") {
      if (!node.uploadId) {
        throw new ProviderHttpError(400, "invalid_argument", "素材节点还没有上传图片");
      }
      // 只查不消耗：归属/角色/存在性与 createJob 认领同一段判定。
      await readUploadSidecar(node.uploadId, "start", ownerId);
    }
  }
}

/** 「只算不建」：与 `createJob` 相同的归一管线，给出这次会按哪档计费。 */
export function planNodeJob(
  graph: Graph,
  node: CanvasNode,
): {
  mode: Extract<NativeMode, "text_to_image" | "text_to_video" | "image_to_video">;
  prompt: string;
  priceCny: number;
  productName?: string;
} {
  const mode = nodeMode(graph, node);
  const prompt = mergePrompt(graph, node);
  const image = mode === "text_to_image";
  // 画布节点不带时长/画幅选项：与 createJob 的缺省完全一致（视频默认 8s 进归一）。
  const body: Pick<CreateJobBody, "prompt" | "aspectRatio" | "resolution" | "generateAudio"> = {
    prompt,
  };
  const durationSec = image ? 0 : 8;
  const choice = chooseProduct({
    mode,
    requestedId: node.product,
    harness: false,
    needsLastFrame: false,
    referenceCount: 0,
    durationSec: image ? undefined : durationSec,
  });
  const provider = choice.provider;
  const model = modelForProvider(provider, mode, choice.product);
  const product = labelProduct(choice, mode, model);
  const settings = providerSettingsFor(provider, mode, image ? undefined : durationSec, body, model, {
    product: choice.product,
    hasLastFrame: false,
  });
  const dur = image ? 0 : (settings?.durationSec ?? durationSec);
  const resolution = image ? null : (settings?.resolution ?? "720p");
  const generateAudio = image ? false : settings ? settings.audio === "native" : true;
  const imageResolution = image ? ("1k" as const) : null;
  return {
    mode,
    prompt,
    priceCny: priceCny({ mode, durationSec: dur, resolution, generateAudio, imageResolution }),
    productName: product?.name,
  };
}

function shortPrompt(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 40 ? `${one.slice(0, 40)}…` : one;
}

/**
 * 整张图的报价：校验 → 逐生成节点归一报价 → 总价 + hash。
 * `basisHash` 盖住 prompt / 点名产品 / 入边构成——报价之后改过其中任何一样，
 * 创建时重算就对不上，`quote_stale`。
 */
export async function computeQuote(
  ownerId: string,
  doc: CanvasDocument,
): Promise<CanvasQuote> {
  const graph: Graph = { nodes: doc.nodes, edges: doc.edges };
  await validateGraph(graph, ownerId);
  const items: CanvasQuoteItem[] = [];
  for (const node of topoOrder(graph)!.filter(isGenNode)) {
    const plan = planNodeJob(graph, node);
    const basisHash = createHash("sha256")
      .update(
        stableJsonHash({
          prompt: plan.prompt,
          product: node.product ?? null,
          inputs: nodeInputs(graph, node.id)
            .map((n) => `${n.kind}:${n.id}:${n.kind === "material" ? (n.uploadId ?? "") : ""}`)
            .sort(),
        }),
      )
      .digest("hex");
    items.push({
      nodeId: node.id,
      kind: node.kind,
      mode: plan.mode,
      priceCny: plan.priceCny,
      ...(plan.productName ? { productName: plan.productName } : {}),
      summary: shortPrompt(plan.prompt) || node.id,
      basisHash,
    });
  }
  const totalCny = Math.round(items.reduce((s, i) => s + i.priceCny, 0) * 100) / 100;
  const hash = stableJsonHash({
    canvasId: doc.id,
    revision: doc.revision,
    items: items.map((i) => ({
      nodeId: i.nodeId,
      mode: i.mode,
      priceCny: i.priceCny,
      basisHash: i.basisHash,
    })),
  });
  return { hash, totalCny, items };
}
