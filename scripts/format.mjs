import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const check = args.includes("--check");
const forwarded = args.filter((arg) => arg !== "--check" && arg !== "--fix");
const prettier = fileURLToPath(
  new URL("../node_modules/prettier/bin/prettier.cjs", import.meta.url),
);
const result = spawnSync(
  process.execPath,
  [prettier, check ? "--check" : "--write", ".", ...forwarded],
  {
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
