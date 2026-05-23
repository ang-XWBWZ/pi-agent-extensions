// management-semantic.ts — 语义配置工具 (v5.5)
//
// wiki_semantic(action?, model?) — 统一入口：
//   无参 → 状态（含模型列表）
//   action="on" → 启用语义搜索
//   action="off" → 关闭
//   action="model" + id → 切换模型

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import {
  getSources, getIndex, getSemanticEnabled, setSemanticEnabled,
  getEmbeddings, getEmbeddingDim, setEmbeddings, setChunkInfo,
} from "../lib/store.js";
import { generateEmbeddings } from "../lib/indexer.js";
import {
  initialize, isAvailable, getModelName, getModelRepo, getInitError,
  getLocalModelInfo, getModelSource, isDependencyInstalled, downloadModel,
} from "../lib/embedder.js";
import { getBuiltinModels, getCurrentModel, selectModel } from "../lib/model-registry.js";
import { getManifest, updateFileState } from "../lib/file-manifest.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

export function registerSemanticTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wiki_DANGER_semantic",
    label: "Wiki Semantic",
    description:
      "管理语义搜索：查看状态、启用/关闭、切换模型。不传 action 时显示状态和模型列表。",
    promptSnippet: "Manage wiki semantic (action?, autoInstall?, id?)",
    promptGuidelines: [
      "IMPORTANT: Semantic search ≠ Semantic compilation (wiki_compile_file).",
      "  • Semantic search = bge ONNX embeds raw text → cosine similarity. Basic but immediate.",
      "  • Semantic compilation = LLM normalizes → re-embed → higher recall.",
      "  • Independent. Compilation is optional, recommended for fragmented notes.",
      "",
      "## Actions",
      "  wiki_semantic() → status + model list",
      "  wiki_semantic(action='on', autoInstall=true) → enable (auto install deps+model)",
      "  wiki_semantic(action='off') → disable (vectors preserved)",
      "  wiki_semantic(action='model', id='paraphrase-multilingual') → switch model (dim mismatch → auto-clear)",
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.String({ description: "操作: on | off | model（不传=状态）" })),
      autoInstall: Type.Optional(Type.Boolean({ description: "action=on 时自动安装依赖（默认 true）" })),
      id: Type.Optional(Type.String({ description: "action=model 时的目标模型 id" })),
    }),
    async execute(_tcid, params, signal) {
      if (signal?.aborted) throw new Error("aborted");

      // —— status ——
      if (!params.action) {
        const enabled = getSemanticEnabled();
        const embCount = Object.keys(getEmbeddings()).length;
        const depReady = isAvailable();
        const depInstalled = await isDependencyInstalled();
        const model = getModelName();
        const modelSrc = isAvailable() ? getModelSource() : "未加载";
        const localInfo = getLocalModelInfo();

        const lines = [
          "🧠 语义搜索状态",
          `   状态: ${enabled ? "✅ 已启用" : "⏸ 未启用"}`,
          `   依赖: ${depInstalled ? (depReady ? "✅ 已就绪" : "⏳ 已安装但未加载") : "❌ 未安装"}`,
          `   模型: ${model}`,
          `   来源: ${modelSrc}`,
        ];
        if (localInfo) {
          lines.push(`   精度: ${localInfo.variant.toUpperCase()} (${localInfo.onnxSize > 0 ? (localInfo.onnxSize / 1_000_000).toFixed(0) + " MB" : "未知"})`);
        }
        lines.push(`   向量: ${embCount} 条`);
        if (!enabled) lines.push("", "💡 对我说『启用 wiki 语义搜索』即可自动配置。");

        const currentId = getCurrentModel().id;
        const models = getBuiltinModels();
        const storedDim = getEmbeddingDim();
        lines.push("", `📋 可选模型 (${models.length}):`);
        for (const m of models) {
          const marker = m.id === currentId ? " ●" : "  ";
          lines.push(`${marker} ${m.id} — ${m.name} (${m.dim}维 · ${m.maxTokens}t · ${m.languages.slice(0,3).join("/")}${m.languages.length > 3 ? "/…" : ""})`);
        }
        if (embCount > 0 && storedDim) {
          const curModel = getCurrentModel();
          const ok = storedDim === curModel.dim ? "✅" : "⚠️ 维度不匹配";
          lines.push("", `📊 已存: ${embCount} 条 / ${storedDim}维 ${ok}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // —— off ——
      if (params.action === "off" || params.action === "disable") {
        if (!getSemanticEnabled()) {
          return { content: [{ type: "text", text: "⚠️ 语义搜索未启用" }] };
        }
        setSemanticEnabled(false);
        const embCount = Object.keys(getEmbeddings()).length;
        return { content: [{ type: "text", text: `🔒 语义搜索已关闭（${embCount} 条向量保留）` }] };
      }

      // —— model ——
      if (params.action === "model") {
        if (!params.id) {
          return { content: [{ type: "text", text: "❌ 请指定模型 id（见 wiki_semantic 输出）" }] };
        }
        const currentModel = getCurrentModel();
        if (params.id === currentModel.id) {
          return { content: [{ type: "text", text: `⚠️ 已在使用: ${currentModel.name}` }] };
        }
        const newModel = selectModel(params.id);
        if (!newModel) {
          const ids = getBuiltinModels().map((m) => m.id).join(", ");
          return { content: [{ type: "text", text: `❌ 未知模型: ${params.id}\n可用: ${ids}` }] };
        }
        const storedDim = getEmbeddingDim();
        const dimChanged = storedDim != null && storedDim !== newModel.dim;
        if (dimChanged) {
          setEmbeddings({}, newModel.hfRepo, newModel.dim);
          setChunkInfo({});
          // 重置文件编译/向量状态（维度变化后全部失效）
          const mf = getManifest();
          for (const key of Object.keys(mf.files)) {
            mf.files[key] = { md5: "", astChunkCount: 0, astIndexedAt: "", llmCompiled: false, hasSemanticVectors: false };
          }
          const manifestPath = resolve(__dirname, "..", "manifest.json");
          writeFileSync(manifestPath, JSON.stringify(mf, null, 2), "utf-8");
        }

        // 自动下载模型文件（如本地不存在）
        const dlResult = downloadModel(newModel.id);

        const lines = [
          `✅ 已切换: ${currentModel.id} → ${newModel.id}`,
          `   ${newModel.name} (${newModel.dim}维 · ${newModel.maxTokens}t · ${newModel.languages.slice(0, 3).join("/")}${newModel.languages.length > 3 ? "/…" : ""})`,
        ];
        lines.push(`   ${dlResult.msg}`);
        if (dimChanged) lines.push("", "⚠️ 维度变化，旧向量已清除。用 wiki_semantic(action='on') 重建。");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // —— on ——
      if (params.action === "on" || params.action === "enable") {
        const doInstall = params.autoInstall !== false;
        const wikiDir = resolve(__dirname, "..");
        let ok = await initialize();

        if (!ok) {
          const err = getInitError() || "";
          const isMissingDep = err.includes("Cannot find module") || err.includes("Failed to resolve") || err.includes("Module not found");
          if (isMissingDep) {
            if (!doInstall) {
              return { content: [{ type: "text", text: "❌ 依赖未安装。设 autoInstall: true 自动安装。" }] };
            }
            try {
              execSync("npm install @huggingface/transformers", { encoding: "utf-8", timeout: 180_000, cwd: wikiDir });
            } catch (e: any) {
              return { content: [{ type: "text", text: `❌ npm 安装失败: ${e?.stderr || e?.message || String(e)}` }] };
            }
            ok = await initialize();
          }
          if (!ok && getLocalModelInfo() === null) {
            const model = getCurrentModel();
            const scriptName = process.platform === "win32" ? "init-wiki-model.bat" : "init-wiki-model.sh";
            const scriptPath = resolve(wikiDir, "scripts", scriptName);
            try {
              execSync(`"${scriptPath}" ${model.id}`, { encoding: "utf-8", timeout: 600_000, cwd: wikiDir, stdio: "pipe" });
            } catch (e: any) {
              return { content: [{ type: "text", text: `❌ 模型下载失败: ${e?.stderr || e?.message || String(e)}` }] };
            }
            ok = await initialize();
          }
          if (!ok) {
            return { content: [{ type: "text", text: `❌ 初始化失败: ${getInitError() || "未知"}` }] };
          }
        }

        setSemanticEnabled(true);
        const sources = getSources();
        let total = 0;
        for (const src of sources) {
          const entries = Object.values(getIndex()).filter((e) => e.sourceDir === src);
          const count = await generateEmbeddings(src, entries);
          total += count;
        }
        return {
          content: [{ type: "text", text: `✅ 语义搜索已启用\n🧠 ${getModelName()}\n📊 ${total} 条向量` }],
          details: { enabled: true, model: getModelName(), embeddings: total },
        };
      }

      return { content: [{ type: "text", text: `❌ 未知 action: ${params.action}\n可用: on | off | model（不传=状态）` }] };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text) ?? new Text("", 0, 0);
      const a = args.action ?? "status";
      const m = args.id ? ` ${args.id}` : "";
      text.setText(theme.fg("toolTitle", theme.bold(`wiki_semantic(${a}${m})`)));
      return text;
    },
  });
}
