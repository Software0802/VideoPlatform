import { grokNativeProvider } from "@/lib/providers/grok/native";
import { jimengProvider } from "@/lib/providers/jimeng";
import { klingProvider } from "@/lib/providers/kling/native";
import { mockProvider } from "@/lib/providers/mock";
import { assembleRelays } from "@/lib/providers/relay/assemble";
import { registerProvider } from "@/lib/providers/registry";

/**
 * 内建 provider 的装配：模块加载时把各家注册进 `registry.ts`。
 *
 * 独立成模块是为了让 `registry.ts` 保持「只持有 Map、不认识任何实现」——注册表
 * 反向 import 各 native 会绕成循环依赖。凡是会碰到注册表的代码路径都经
 * `router.ts`（它 import 本模块）。
 *
 * grok / mock / jimeng / kling 是代码内建；openai 与 yman 以及全部 relay 由
 * `relay/assemble.ts` 按 `data/relays.json` / `LUMEN_RELAYS` / 老 env 折算注册
 * （含 mtime 热重载），不在这里写死。
 */
registerProvider(grokNativeProvider);
registerProvider(mockProvider);
registerProvider(jimengProvider);
registerProvider(klingProvider);

assembleRelays();
