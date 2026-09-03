import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pins = JSON.parse(readFileSync(join(root, "docs/data-workshop-v1/v3/REPOSITORY_PINS.json"), "utf8"));

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const failures = [];
for (const product of pins.products) {
  const label = `${product.name}@${product.default_branch}`;
  let localHead;
  let trackedStatus;
  let remote;
  try {
    localHead = git(["rev-parse", "HEAD"], product.local_checkout);
    trackedStatus = git(["status", "--porcelain=v1", "--untracked-files=no"], product.local_checkout);
    remote = git(
      ["ls-remote", "--symref", product.canonical_remote, "HEAD", `refs/heads/${product.default_branch}`],
      root,
    );
  } catch (error) {
    failures.push(`${label}: ${error.stderr?.trim() || error.message}`);
    continue;
  }
  const defaultRef = `ref: refs/heads/${product.default_branch}\tHEAD`;
  const remoteBranch = `${product.full_sha}\trefs/heads/${product.default_branch}`;
  if (localHead !== product.full_sha) {
    failures.push(`${label}: local HEAD ${localHead} does not match frozen SHA`);
  }
  if (trackedStatus) {
    failures.push(`${label}: tracked checkout is dirty`);
  }
  if (!remote.includes(defaultRef)) {
    failures.push(`${label}: remote HEAD is not the frozen default branch`);
  }
  if (!remote.includes(remoteBranch)) {
    failures.push(`${label}: remote default branch does not match frozen SHA`);
  }
}

if (failures.length > 0) {
  console.error(`DWV1 V3 repository verification failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("DWV1 V3 repository verification passed");
for (const product of pins.products) {
  console.log(`${product.name}\t${product.default_branch}\t${product.full_sha}`);
}
