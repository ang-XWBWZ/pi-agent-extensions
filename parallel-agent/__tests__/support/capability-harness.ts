import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSessionCapabilityOperations } from "../../../lib/capability-dispatch.js";

export function captureOperation(register: (pi: ExtensionAPI) => void, name: string): any {
  const handlers: Array<(event: any, ctx: any) => void> = [];
  const manager = {};
  register({
    on: (event: string, handler: any) => { if (event === "session_start") handlers.push(handler); },
    registerTool: () => {},
  } as unknown as ExtensionAPI);
  for (const handler of handlers) handler({}, { sessionManager: manager });
  const operation = getSessionCapabilityOperations(manager).get(name);
  if (!operation) throw new Error(`Missing operation: ${name}`);
  return operation.definition;
}
