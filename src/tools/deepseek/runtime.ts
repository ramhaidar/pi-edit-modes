import { resolve } from "node:path";
import { DeepSeekFsParity } from "./fs-parity.ts";

const runtimes = new Map<string, DeepSeekFsParity>();

export interface DeepSeekRuntimeScope {
  cwd: string;
  sessionManager?: { getSessionId(): string };
}

export function getDeepSeekFsRuntime(scope: string | DeepSeekRuntimeScope): DeepSeekFsParity {
  const cwd = typeof scope === "string" ? scope : scope.cwd;
  const sessionId = typeof scope === "string" ? "__legacy__" : scope.sessionManager?.getSessionId() ?? "__unknown_session__";
  const workspace = resolve(cwd);
  const key = `${sessionId}\0${workspace}`;
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = new DeepSeekFsParity(workspace, true);
    runtimes.set(key, runtime);
  }
  return runtime;
}

export function clearDeepSeekFsRuntimes(): void {
  for (const runtime of runtimes.values()) runtime.clear();
  runtimes.clear();
}
