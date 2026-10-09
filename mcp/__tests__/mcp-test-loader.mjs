import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sdkRootUrl = new URL(
  "../node_modules/@modelcontextprotocol/sdk/dist/esm/",
  import.meta.url,
).href;
const sdkSpecifierPrefix = "@modelcontextprotocol/sdk/";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(sdkSpecifierPrefix)) {
    return {
      url: new URL(specifier.slice(sdkSpecifierPrefix.length), sdkRootUrl).href,
      shortCircuit: true,
    };
  }

  if (specifier.endsWith(".js") && context.parentURL?.startsWith(new URL("../", import.meta.url).href)) {
    const tsUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(tsUrl))) {
      return { url: tsUrl.href, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
