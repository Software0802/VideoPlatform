/*
  创作搭子 →「智能体」之间那句提示词的交接。

  它只走 sessionStorage，不进地址栏：`(shell)` 是 force-dynamic，`/agent?q=…` 这样的
  跳转会把用户原话带进浏览器历史，以及生产上那台反代的访问日志（AGENTS.md：借用 taiyu
  的 Caddy）。提示词此前只在 POST 体里走，这里保持同一条线。

  同标签页内有效、取一次就清：智能体那边回填后再清空输入框，不会被重新填回去。
*/

const DRAFT_KEY = "lumen.agent.draft";

/** 与智能体输入框、服务端 schema 同一个上限。 */
export const AGENT_DRAFT_MAX = 2000;

export function stashAgentDraft(text: string): void {
  try {
    const one = text.trim().slice(0, AGENT_DRAFT_MAX);
    if (one) sessionStorage.setItem(DRAFT_KEY, one);
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* 隐私模式 / 非浏览器环境：没带过去就是空输入框，不影响跳转 */
  }
}

/** 读走并清掉；没有就是空串。 */
export function takeAgentDraft(): string {
  try {
    const one = sessionStorage.getItem(DRAFT_KEY);
    if (one !== null) sessionStorage.removeItem(DRAFT_KEY);
    return one ?? "";
  } catch {
    return "";
  }
}
