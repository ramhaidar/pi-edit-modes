import { resolve } from "node:path";
import { DeepSeekFsParity } from "./fs-parity.ts";

const runtimes = new Map<string, DeepSeekFsParity>();

export function getDeepSeekFsRuntime(cwd: string): DeepSeekFsParity {
  const key = resolve(cwd);
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = new DeepSeekFsParity(key, true);
    runtimes.set(key, runtime);
  }
  return runtime;
}

export function clearDeepSeekFsRuntimes(): void {
  for (const runtime of runtimes.values()) runtime.clear();
  runtimes.clear();
}
