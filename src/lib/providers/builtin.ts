import { grokNativeProvider } from "@/lib/providers/grok/native";
import { jimengProvider } from "@/lib/providers/jimeng";
import { klingProvider } from "@/lib/providers/kling/native";
import { mockProvider } from "@/lib/providers/mock";
import { openaiImageProvider } from "@/lib/providers/openai-image/native";
import { registerProvider } from "@/lib/providers/registry";
import { ymanProvider } from "@/lib/providers/yman/native";

/**
 * 内建 provider 的装配：模块加载时把六家注册进 `registry.ts`。
 *
 * 独立成模块是为了让 `registry.ts` 保持「只持有 Map、不认识任何实现」——注册表
 * 反向 import 各 native 会绕成循环依赖。凡是会碰到注册表的代码路径都经
 * `router.ts`（它 import 本模块），relay 的装配代码同样在这里之外的装配点注册。
 */
registerProvider(grokNativeProvider);
registerProvider(mockProvider);
registerProvider(jimengProvider);
registerProvider(openaiImageProvider);
registerProvider(klingProvider);
registerProvider(ymanProvider);
