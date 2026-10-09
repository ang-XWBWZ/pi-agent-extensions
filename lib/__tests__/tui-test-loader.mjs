const stubs = new Map([
  ["@earendil-works/pi-tui", new URL("./tui-stub.ts", import.meta.url).href],
]);

export async function resolve(specifier, context, defaultResolve) {
  const stub = stubs.get(specifier);
  if (stub) return { url: stub, shortCircuit: true };

  if (
    specifier.endsWith(".js") &&
    context.parentURL?.startsWith(new URL("../", import.meta.url).href)
  ) {
    const url = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    return { url: url.href, shortCircuit: true };
  }

  return defaultResolve(specifier, context, defaultResolve);
}
