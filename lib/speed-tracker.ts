/**
 * speed-tracker.ts — Token 生成速率与耗时统计追踪器
 *
 * 统一管理单轮次及会话全局的 TTFT（首字延迟）、生成速率（Output TPS）、
 * 端到端耗时、输出 Token 计数。
 * 保障全局单例一致，提供纯文本格式化输出（无表情符号）。
 */

export interface TurnSpeedStats {
  startTime: number;
  firstTokenTime?: number;
  endTime?: number;
  ttftMs?: number;
  genDurationMs?: number;
  totalDurationMs?: number;
  outputTokens: number;
  reasoningTokens: number;
  inputTokens?: number;
  outputTps: number;
  totalTps: number;
  isStreaming: boolean;
}

export interface SessionSpeedStats {
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalGenDurationMs: number;
  totalDurationMs: number;
  avgOutputTps: number;
  totalTurns: number;
}

export class SpeedTracker {
  private currentTurn?: {
    startTime: number;
    firstTokenTime?: number;
    charCount: number;
    isStreaming: boolean;
  };

  private latest?: TurnSpeedStats;

  private session: SessionSpeedStats = {
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalGenDurationMs: 0,
    totalDurationMs: 0,
    avgOutputTps: 0,
    totalTurns: 0,
  };

  /** 开始新的一条消息生成跟踪 */
  startMessage(role: string): void {
    if (role !== "assistant") return;
    this.currentTurn = {
      startTime: Date.now(),
      charCount: 0,
      isStreaming: true,
    };
  }

  /** 收到首个 token/chunk 时记录 */
  recordFirstToken(): void {
    if (!this.currentTurn || this.currentTurn.firstTokenTime) return;
    const now = Date.now();
    this.currentTurn.firstTokenTime = now;
  }

  /** 流式吐字时累加更新，返回当前估算 TPS 文本（纯文本无表情） */
  updateLiveProgress(deltaChars: number): string | undefined {
    if (!this.currentTurn || !this.currentTurn.isStreaming) return undefined;
    if (!this.currentTurn.firstTokenTime) {
      this.recordFirstToken();
    }
    this.currentTurn.charCount += Math.max(0, deltaChars);

    const now = Date.now();
    const elapsedSec = (now - (this.currentTurn.firstTokenTime ?? this.currentTurn.startTime)) / 1000;
    if (elapsedSec < 0.1) {
      return "... t/s";
    }

    // 粗估 Token 数：字符数 / 3.2
    const estTokens = Math.max(1, Math.round(this.currentTurn.charCount / 3.2));
    const liveTps = (estTokens / elapsedSec).toFixed(1);
    return `${liveTps} t/s`;
  }

  /** 消息生成完成，计算权威数据 */
  finishMessage(usage?: { input?: number; output?: number; reasoning?: number }): TurnSpeedStats | undefined {
    if (!this.currentTurn) return this.latest;

    const now = Date.now();
    const startTime = this.currentTurn.startTime;
    const firstTokenTime = this.currentTurn.firstTokenTime ?? startTime;
    const endTime = now;

    const ttftMs = Math.max(0, firstTokenTime - startTime);
    const genDurationMs = Math.max(1, endTime - firstTokenTime);
    const totalDurationMs = Math.max(1, endTime - startTime);

    // 优先采用服务端返回的权威 output token 数
    const outputTokens = typeof usage?.output === "number" && usage.output >= 0
      ? usage.output
      : Math.max(1, Math.round(this.currentTurn.charCount / 3.2));

    const reasoningTokens = typeof usage?.reasoning === "number" && usage.reasoning >= 0
      ? usage.reasoning
      : 0;

    const inputTokens = typeof usage?.input === "number" && usage.input >= 0
      ? usage.input
      : undefined;

    const outputTps = outputTokens / (genDurationMs / 1000);
    const totalTps = outputTokens / (totalDurationMs / 1000);

    const stats: TurnSpeedStats = {
      startTime,
      firstTokenTime,
      endTime,
      ttftMs,
      genDurationMs,
      totalDurationMs,
      outputTokens,
      reasoningTokens,
      inputTokens,
      outputTps,
      totalTps,
      isStreaming: false,
    };

    this.latest = stats;
    this.currentTurn = undefined;

    // 累加到会话统计
    this.session.totalOutputTokens += outputTokens;
    this.session.totalReasoningTokens += reasoningTokens;
    this.session.totalGenDurationMs += genDurationMs;
    this.session.totalDurationMs += totalDurationMs;
    this.session.totalTurns += 1;
    this.session.avgOutputTps = this.session.totalGenDurationMs > 0
      ? this.session.totalOutputTokens / (this.session.totalGenDurationMs / 1000)
      : 0;

    return stats;
  }

  /** 获取最新一轮完成的速率统计 */
  getLatestStats(): TurnSpeedStats | undefined {
    return this.latest;
  }

  /** 获取会话累计速率统计 */
  getSessionStats(): SessionSpeedStats {
    return { ...this.session };
  }

  /** 是否正在流式生成中 */
  isStreaming(): boolean {
    return !!this.currentTurn?.isStreaming;
  }

  /** 重置统计数据（用于会话切换等） */
  reset(): void {
    this.currentTurn = undefined;
    this.latest = undefined;
    this.session = {
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      totalGenDurationMs: 0,
      totalDurationMs: 0,
      avgOutputTps: 0,
      totalTurns: 0,
    };
  }

  /**
   * 格式化底栏状态文本：
   * 纯文本，只显示速率，绝不加任何 emoji 表情。
   * - 未生成过：返回 undefined
   * - 生成完成：如 "48.2 t/s"
   */
  formatStatusLabel(): string | undefined {
    if (this.currentTurn?.isStreaming) {
      const now = Date.now();
      const elapsedSec = (now - (this.currentTurn.firstTokenTime ?? this.currentTurn.startTime)) / 1000;
      if (elapsedSec < 0.1) return "... t/s";
      const estTokens = Math.max(1, Math.round(this.currentTurn.charCount / 3.2));
      return `${(estTokens / elapsedSec).toFixed(1)} t/s`;
    }

    if (this.latest) {
      return `${this.latest.outputTps.toFixed(1)} t/s`;
    }

    return undefined;
  }
}

// 全局单例保活
const GLOBAL_KEY = "__pi_speed_tracker";
const globalTracker: SpeedTracker = ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as SpeedTracker) ||
  (() => {
    const tracker = new SpeedTracker();
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = tracker;
    return tracker;
  })();

export function getSpeedTracker(): SpeedTracker {
  return globalTracker;
}
