import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const piAiStubUrl = new URL("./pi-ai-stub.ts", import.meta.url).href;
const piCodingAgentStubUrl = new URL("./pi-coding-agent-stub.ts", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-ai") {
    return { url: piAiStubUrl, shortCircuit: true };
  }
  if (specifier === "@earendil-works/pi-coding-agent") {
    return { url: piCodingAgentStubUrl, shortCircuit: true };
  }


  if (specifier.endsWith(".js") && context.parentURL?.includes("/provider-manager/")) {
    const tsUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(tsUrl))) {
      return { url: tsUrl.href, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
