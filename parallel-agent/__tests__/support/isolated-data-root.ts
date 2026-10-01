/**
 * 测试隔离：确保 agent-bus 读写的是临时数据根，而不是真实用户状态目录。
 *
 * 必须在 import agent-bus 之前作为第一个 import 加载。agentDataDir() 在每次
 * 调用时读取 PI_AGENT_DATA_DIR，因此先设置即可生效。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PI_AGENT_DATA_DIR?.trim()) {
  const dir = mkdtempSync(join(tmpdir(), "pi-agent-test-state-"));
  process.env.PI_AGENT_DATA_DIR = dir;
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 测试退出时的清理失败不改变测试结果
    }
  });
}
