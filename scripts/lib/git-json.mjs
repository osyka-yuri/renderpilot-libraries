import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function readJsonAtGitRef(ref, repoPath, { cwd, maxBuffer } = {}) {
  const { stdout: names } = await execFileAsync(
    "git",
    ["ls-tree", "-r", "--name-only", ref, "--", repoPath],
    { cwd },
  );
  if (!names.split(/\r?\n/u).includes(repoPath)) return null;

  const { stdout } = await execFileAsync("git", ["show", `${ref}:${repoPath}`], {
    cwd,
    maxBuffer,
  });
  return JSON.parse(stdout);
}
