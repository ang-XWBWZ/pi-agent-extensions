/** Capability catalog and session-local loading.
 * Native tool definitions are fixed; guides and operation schemas are returned
 * at the transcript tail. Loading never registers or mounts native tools.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConversationPhase } from "./workflow-types.js";
import { currentSessionRuntime, getSessionRuntime } from "./session-runtime.js";

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

  /** 每个工具的简要功能说明字典（用于生成功能清单，让 AI 知道具体工具是做什么的） */
  toolDescriptions?: Record<string, string>;

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
  "manage_plan",
  "manage_requirements",
  "load_capability",
  "call_capability",
];

export const CHAT_CORE_TOOLS = ["read", "load_capability"];

export const PLAN_CORE_TOOLS = [
  "read",
  "bash",
  "cmd",
  "powershell",
  "manage_requirements",
  "load_capability",
];

export interface RegistryCatalog {
  manifests: Map<string, CapabilityManifest>;
  toolToCapability: Map<string, string>;
}

export interface CapabilityActivationState {
  activated: Set<string>;
  activating: Map<string, Promise<void>>;
  /** Fixed native tool set initialized once per session. */
  mountedTools: Set<string>;
}

const CATALOG_KEY = "__pi_capability_catalog";
const ACTIVATION_KEY = "__pi_capability_activation_state";

export function createCapabilityActivationState(): CapabilityActivationState {
  return {
    activated: new Set<string>(),
    activating: new Map<string, Promise<void>>(),
    mountedTools: new Set<string>(),
  };
}

function getRegistryCatalog(): RegistryCatalog {
  const globals = globalThis as Record<string, unknown>;
  if (!globals[CATALOG_KEY]) {
    globals[CATALOG_KEY] = {
      manifests: new Map<string, CapabilityManifest>(),
      toolToCapability: new Map<string, string>(),
    };
  }
  return globals[CATALOG_KEY] as RegistryCatalog;
}

/**
 * 返回当前能力激活状态。
 *
 * A04：优先返回当前会话自己的激活状态（通过 AsyncLocalStorage 解析）；只有
 * 没有会话作用域时才退回全局兼容状态。因此子会话启动/销毁不会清空父会话
 * 的已激活能力。
 */
export function getDefaultActivationState(
  sessionManager?: object,
): CapabilityActivationState {
  const runtime = sessionManager
    ? getSessionRuntime(sessionManager)
    : currentSessionRuntime();
  if (runtime) return runtime.capabilityActivation;
  const globals = globalThis as Record<string, unknown>;
  if (!globals[ACTIVATION_KEY]) {
    globals[ACTIVATION_KEY] = createCapabilityActivationState();
  }
  return globals[ACTIVATION_KEY] as CapabilityActivationState;
}

interface RegistryState {
  manifests: Map<string, CapabilityManifest>;
  toolToCapability: Map<string, string>;
  activated: Set<string>;
}

/** 兼容旧代码访问 */
function getRegistryState(): RegistryState {
  const catalog = getRegistryCatalog();
  const activation = getDefaultActivationState();
  return {
    manifests: catalog.manifests,
    toolToCapability: catalog.toolToCapability,
    activated: activation.activated,
  };
}

/** 注册插件能力清单 */
export function registerCapability(manifest: CapabilityManifest): void {
  const catalog = getRegistryCatalog();
  const previous = catalog.manifests.get(manifest.id);

  // 清除旧 manifest 关联工具的反向映射，避免 hot reload 留下脏映射
  if (previous) {
    for (const tool of previous.tools) {
      if (catalog.toolToCapability.get(tool) === manifest.id) {
        catalog.toolToCapability.delete(tool);
      }
    }
  }

  catalog.manifests.set(
    manifest.id,
    Object.freeze({
      ...manifest,
      tools: Object.freeze([...manifest.tools]),
      keywords: Object.freeze([...manifest.keywords]),
    }) as CapabilityManifest,
  );

  for (const tool of manifest.tools) {
    catalog.toolToCapability.set(tool, manifest.id);
  }
}

/** 获取所有已注册的能力清单 */
export function getRegisteredCapabilities(): CapabilityManifest[] {
  return Array.from(getRegistryCatalog().manifests.values());
}

/** 获取单个能力清单 */
export function getCapability(id: string): CapabilityManifest | undefined {
  return getRegistryCatalog().manifests.get(id);
}

/** 通过工具名反查所属能力清单 */
export function findCapabilityByTool(toolName: string): CapabilityManifest | undefined {
  const catalog = getRegistryCatalog();
  const capId = catalog.toolToCapability.get(toolName);
  return capId ? catalog.manifests.get(capId) : undefined;
}

/** 检查某能力是否已被激活 */
export function isCapabilityActive(
  id: string,
  activation: CapabilityActivationState = getDefaultActivationState(),
): boolean {
  return activation.activated.has(id);
}

/** 重置激活状态（支持传入特定 session 状态或重置全局默认状态） */
export function resetActivatedCapabilities(
  activation: CapabilityActivationState = getDefaultActivationState(),
): void {
  activation.activated.clear();
  activation.activating.clear();
  activation.mountedTools.clear();
}

/**
 * 生成首轮不可变能力索引卡（XML 格式）
 * 按照 id 字典序排序，仅供兼容调用展示；不再进入系统提示词，也不承诺服务端缓存命中
 */
export function formatImmutableCapabilityIndex(): string {
  const caps = getRegisteredCapabilities().sort((a, b) => a.id.localeCompare(b.id));
  if (caps.length === 0) return "";

  const lines = [
    "<subsystems>",
    "Specialized capabilities are loaded on demand via load_capability({ capability: string }).",
  ];
  for (const cap of caps) {
    const toolsStr = cap.tools.length > 0 ? ` [tools: ${cap.tools.join(", ")}]` : "";
    lines.push(`- ${cap.id}: ${cap.summary}${toolsStr}`);
  }
  lines.push("</subsystems>");
  return lines.join("\n");
}

/**
 * 格式化输出全量功能清单与每个工具的具体用途说明
 * 用于 /capabilities 命令与 load_capability action="list" / 未提供参数时的 AI 指引
 */
export function formatFullCapabilityCatalog(): string {
  const caps = getRegisteredCapabilities().sort((a, b) => a.id.localeCompare(b.id));
  const lines: string[] = [
    "================================================================================",
    "                     系统能力与工具功能清单 (Capability Catalog)",
    "================================================================================",
    "【常驻核心基础工具 (Baseline Core Tools)】",
    "  - read: 读取工作区或允许路径下的文件内容",
    "  - edit: 按指定文本块修改文件内容",
    "  - write: 创建新文件或覆盖已有文件",
    "  - bash: 执行 Linux / macOS / Unix Bash 终端命令",
    "  - cmd: 执行 Windows CMD 命令行指令",
    "  - powershell: 执行 Windows PowerShell 命令行指令",
    "  - manage_plan: WORK 阶段多步骤任务执行计划管理 (新增/更新/完成/重排步骤)",
    "  - load_capability: 按需激活进阶能力子系统 (load_capability({ capability: '<id>' }))",
    "",
    "【可用进阶能力清单 (通过 load_capability 加载说明)】",
  ];

  if (caps.length === 0) {
    lines.push("  (暂无注册的进阶能力)");
  } else {
    for (const cap of caps) {
      const phases = cap.phases && cap.phases.length > 0 ? cap.phases.join(", ") : "work";
      lines.push(`- [${cap.id}] ${cap.name} (阶段: ${phases})`);
      lines.push(`  摘要: ${cap.summary}`);
      lines.push("  包含工具与具体用途:");
      if (cap.tools.length === 0) {
        lines.push("    (无独立工具)");
      } else {
        for (const tool of cap.tools) {
          const desc = cap.toolDescriptions?.[tool] ?? "该能力提供的子系统扩展工具";
          lines.push(`    * ${tool}: ${desc}`);
        }
      }
      lines.push("");
    }
  }

  lines.push("--------------------------------------------------------------------------------");
  lines.push("使用方式:");
  lines.push("  - AI 调用工具: load_capability({ capability: '<id>' }) 加载指定能力说明，然后通过 call_capability 调用操作");
  lines.push("  - AI 查询清单: load_capability({ action: 'list' }) 查看最新全量能力清单");
  lines.push("  - 用户终端命令: /capabilities 或 /caps 随时查看此功能卡片");
  lines.push("================================================================================");
  return lines.join("\n");
}

/**
 * 激活执行层能力；不修改模型请求的工具定义或系统提示词
 */
export async function activateCapability(
  id: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  currentPhase: ConversationPhase = "work",
  activation: CapabilityActivationState = getDefaultActivationState(),
  sessionManager?: object,
): Promise<ActivationResult> {
  const catalog = getRegistryCatalog();
  const manifest = catalog.manifests.get(id);
  if (!manifest) {
    const available = Array.from(catalog.manifests.keys()).join(", ");
    return {
      success: false,
      message: `未找到指定能力标识符: "${id}"。当前可用能力: [${available}]。\n\n${formatFullCapabilityCatalog()}`,
    };
  }

  const allowedPhases = manifest.phases ?? ["work"];
  if (!allowedPhases.includes(currentPhase)) {
    return {
      success: false,
      message: `能力 [${manifest.name}] 在当前阶段 (${currentPhase.toUpperCase()}) 不可用。允许阶段: [${allowedPhases.join(", ")}]`,
    };
  }

  // 并发 Single-Flight 机制：避免同一 turn 或并行调用中重复触发 onActivate
  if (manifest.onActivate && !activation.activated.has(id)) {
    let inFlight = activation.activating.get(id);
    if (!inFlight) {
      inFlight = Promise.resolve(manifest.onActivate(ctx)).then(() => undefined);
      activation.activating.set(id, inFlight);
    }

    try {
      await inFlight;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `激活能力 [${manifest.name}] 时发生初始化异常: ${msg}`,
      };
    } finally {
      if (activation.activating.get(id) === inFlight) {
        activation.activating.delete(id);
      }
    }
  }

  activation.activated.add(id);

  // Loading changes execution availability only. Never change request-level tools.

  return {
    success: true,
    message: `能力 [${manifest.name}] 激活成功，可通过 call_capability 调用操作: [${manifest.tools.join(", ")}]`,
    doc: manifest.usageDoc,
    activatedTools: manifest.tools,
  };
}

/**
 * 纯函数计算指定 phase 与激活状态下的活跃工具集
 */
export function computeActiveTools(
  phase: ConversationPhase,
  activation: CapabilityActivationState = getDefaultActivationState(),
  allowedTools?: ReadonlySet<string>,
): string[] {
  const coreList =
    phase === "chat"
      ? CHAT_CORE_TOOLS
      : phase === "plan"
        ? PLAN_CORE_TOOLS
        : BASELINE_CORE_TOOLS;

  const activeTools = new Set<string>(coreList);
  const catalog = getRegistryCatalog();

  for (const capId of activation.activated) {
    const manifest = catalog.manifests.get(capId);
    if (!manifest) continue;
    const allowedPhases = manifest.phases ?? ["work"];
    if (allowedPhases.includes(phase)) {
      for (const t of manifest.tools) {
        activeTools.add(t);
      }
    }
  }

  // A08：阶段允许集 ∩ 已激活能力 ∩ 子任务工具上限。上限之外的工具（包括
  // 派发与生命周期管理安全网）在激活能力后也不得被重新打开。
  if (allowedTools) {
    for (const tool of Array.from(activeTools)) {
      if (!allowedTools.has(tool)) activeTools.delete(tool);
    }
  }

  return Array.from(activeTools);
}

/** Initialize a phase-independent native loadout once. Permissions are checked
 * at execution; capability loads never change this list or its order.
 */
export function syncActiveToolsForPhase(
  phase: ConversationPhase,
  pi: ExtensionAPI,
  activation: CapabilityActivationState = getDefaultActivationState(),
  sessionManager?: object,
): void {
  if (typeof pi.setActiveTools !== "function") return;
  const runtime = sessionManager
    ? getSessionRuntime(sessionManager)
    : currentSessionRuntime();
  // Fixed for the entire session, irrespective of phase and loaded capabilities.
  // Execution-time checks enforce phase and the logical child tool ceiling.
  const fixed = BASELINE_CORE_TOOLS.filter((tool) =>
    !runtime?.allowedTools || runtime.allowedTools.has(tool));
  if (activation.mountedTools.size > 0) return;
  for (const tool of fixed) activation.mountedTools.add(tool);
  pi.setActiveTools(fixed);
}
