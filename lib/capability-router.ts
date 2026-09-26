/**
 * capability-router.ts — 渐进式能力路由器与 PCS (Progressive Capability Specification) 注册中枢
 *
 * 核心设计目标：
 * 1. 极致降低首轮初始提示词（System Prompt + Tools Schema 从 23K+ 降至 ~3K）；
 * 2. 100% 保护大模型前缀缓存（Prompt Caching）：系统提示词字节级冻结，新能力通过尾部 tool_result 与 deferred tools 挂载；
 * 3. 保证大模型激活有效性：首轮提供确定性元索引卡，支持 JIT load_capability 激活。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConversationPhase } from "./workflow-types.js";

export interface CapabilityManifest {
  /** 唯一标识符，全系统唯一，如 "parallel_agent", "work_goal" */
  id: string;

  /** 显示名称（人类可读） */
  name: string;

  /**
   * 极简单行摘要（用于首轮 System Prompt 的不可变元索引卡）
   * 严格限制在 100 字符以内，描述适用场景与核心动作
   */
  summary: string;

  /** 触发关键词/意图特征（用于意图匹配与检索） */
  keywords: string[];

  /**
   * 适用的会话阶段（用于阶段门控隔离）
   * 默认: ["work"] (即在 /chat 和 /plan 阶段该能力完全不可见)
   */
  phases?: Array<"chat" | "plan" | "work">;

  /** 该能力包含的工具名称列表 */
  tools: string[];

  /**
   * 深度使用说明文档（Markdown 格式）
   * ！！！绝不能进入首轮 System Prompt ！！！
   * 仅在模型调用 load_capability 激活后，在 tool_result 中作为尾部消息注入给模型
   */
  usageDoc: string;

  /** 可选的激活回调（用于按需启动后台服务、初始化数据等） */
  onActivate?: (ctx: ExtensionContext) => Promise<void> | void;
}

export interface ActivationResult {
  success: boolean;
  message: string;
  doc?: string;
  activatedTools?: string[];
}

export const BASELINE_CORE_TOOLS = [
  "read",
  "edit",
  "write",
  "bash",
  "cmd",
  "powershell",
  "load_capability",
];

export const CHAT_CORE_TOOLS = ["read"];

export const PLAN_CORE_TOOLS = [
  "read",
  "bash",
  "cmd",
  "powershell",
  "manage_requirements",
];

interface RegistryState {
  manifests: Map<string, CapabilityManifest>;
  toolToCapability: Map<string, string>;
  activated: Set<string>;
}

const REGISTRY_KEY = "__pi_capability_registry";

function getRegistryState(): RegistryState {
  const globals = globalThis as Record<string, unknown>;
  if (!globals[REGISTRY_KEY]) {
    globals[REGISTRY_KEY] = {
      manifests: new Map<string, CapabilityManifest>(),
      toolToCapability: new Map<string, string>(),
      activated: new Set<string>(),
    };
  }
  return globals[REGISTRY_KEY] as RegistryState;
}

/** 注册插件能力清单 */
export function registerCapability(manifest: CapabilityManifest): void {
  const state = getRegistryState();
  state.manifests.set(manifest.id, manifest);
  for (const tool of manifest.tools) {
    state.toolToCapability.set(tool, manifest.id);
  }
}

/** 获取所有已注册的能力清单 */
export function getRegisteredCapabilities(): CapabilityManifest[] {
  return Array.from(getRegistryState().manifests.values());
}

/** 获取单个能力清单 */
export function getCapability(id: string): CapabilityManifest | undefined {
  return getRegistryState().manifests.get(id);
}

/** 通过工具名反查所属能力清单 */
export function findCapabilityByTool(toolName: string): CapabilityManifest | undefined {
  const state = getRegistryState();
  const capId = state.toolToCapability.get(toolName);
  return capId ? state.manifests.get(capId) : undefined;
}

/** 检查某能力是否已被激活 */
export function isCapabilityActive(id: string): boolean {
  return getRegistryState().activated.has(id);
}

/** 重置激活状态（主要用于会话重置或测试） */
export function resetActivatedCapabilities(): void {
  getRegistryState().activated.clear();
}

/**
 * 生成首轮不可变能力索引卡（XML 格式）
 * 按照 id 字典序排序，保证输出字符串绝对恒定，确保大模型 System Prompt 前缀缓存 100% 命中
 */
export function formatImmutableCapabilityIndex(): string {
  const caps = getRegisteredCapabilities().sort((a, b) => a.id.localeCompare(b.id));
  if (caps.length === 0) return "";

  const lines = [
    "<subsystems>",
    "Specialized capabilities are loaded on demand via load_capability({ capability: string }).",
  ];
  for (const cap of caps) {
    lines.push(`- ${cap.id}: ${cap.summary}`);
  }
  lines.push("</subsystems>");
  return lines.join("\n");
}

/**
 * 激活指定能力（纯追加式，完全不碰 System Prompt，前缀缓存安全）
 */
export async function activateCapability(
  id: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<ActivationResult> {
  const state = getRegistryState();
  const manifest = state.manifests.get(id);
  if (!manifest) {
    const available = Array.from(state.manifests.keys()).join(", ");
    return {
      success: false,
      message: `未找到指定能力标识符: "${id}"。当前可用能力: [${available}]`,
    };
  }

  // 触发插件自定义激活生命周期
  if (manifest.onActivate && !state.activated.has(id)) {
    try {
      await manifest.onActivate(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `激活能力 [${manifest.name}] 时发生初始化异常: ${msg}`,
      };
    }
  }

  // 纯追加式扩展活跃工具（Purely Additive）
  const currentTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
  const nextTools = Array.from(new Set([...currentTools, ...manifest.tools]));
  if (typeof pi.setActiveTools === "function") {
    pi.setActiveTools(nextTools);
  }

  state.activated.add(id);

  return {
    success: true,
    message: `能力 [${manifest.name}] 激活成功，已挂载工具: [${manifest.tools.join(", ")}]`,
    doc: manifest.usageDoc,
    activatedTools: manifest.tools,
  };
}

/**
 * 阶段流转时的活跃工具白名单同步
 */
export function syncActiveToolsForPhase(phase: ConversationPhase, pi: ExtensionAPI): void {
  if (typeof pi.setActiveTools !== "function") return;

  const state = getRegistryState();

  if (phase === "chat") {
    pi.setActiveTools(CHAT_CORE_TOOLS);
    return;
  }

  if (phase === "plan") {
    pi.setActiveTools(PLAN_CORE_TOOLS);
    return;
  }

  // WORK 模式：基础核心工具 + 所有处于激活状态且允许在 WORK 模式使用的工具
  const activeTools = new Set<string>(BASELINE_CORE_TOOLS);
  for (const capId of state.activated) {
    const manifest = state.manifests.get(capId);
    if (!manifest) continue;
    const allowedPhases = manifest.phases ?? ["work"];
    if (allowedPhases.includes("work")) {
      for (const t of manifest.tools) {
        activeTools.add(t);
      }
    }
  }

  pi.setActiveTools(Array.from(activeTools));
}
