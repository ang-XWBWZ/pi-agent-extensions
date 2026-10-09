import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const piAiStubUrl = new URL("../../provider-manager/__tests__/pi-ai-stub.ts", import.meta.url).href;
const piCodingAgentStubUrl = new URL("../../provider-manager/__tests__/pi-coding-agent-stub.ts", import.meta.url).href;
const piAgentCoreStubUrl = new URL("../../provider-manager/__tests__/pi-agent-core-stub.ts", import.meta.url).href;
const piTuiStubUrl = new URL("../../lib/__tests__/tui-stub.ts", import.meta.url).href;
const typeboxUrl = new URL("../../mcp/node_modules/typebox/build/index.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-ai") {
    return { url: piAiStubUrl, shortCircuit: true };
  }
  if (specifier === "@earendil-works/pi-coding-agent") {
    return { url: piCodingAgentStubUrl, shortCircuit: true };
  }
  if (specifier === "@earendil-works/pi-agent-core") {
    return { url: piAgentCoreStubUrl, shortCircuit: true };
  }
  if (specifier === "@earendil-works/pi-tui") {
    return { url: piTuiStubUrl, shortCircuit: true };
  }
  if (specifier === "typebox") {
    return { url: typeboxUrl, shortCircuit: true };
  }

  if (specifier.endsWith(".js") && (context.parentURL?.startsWith(new URL("../../", import.meta.url).href) || specifier.startsWith("."))) {
    const tsUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(tsUrl))) {
      return { url: tsUrl.href, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
