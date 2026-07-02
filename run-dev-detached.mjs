import { spawn } from "node:child_process";
import { resolve } from "node:path";

const cwd = resolve("C:/Users/inbod/Documents/Codex/2026-06-15/build-a-web-application-called-into");
const child = spawn("cmd.exe", ["/d", "/c", resolve(cwd, "work/start-dev.cmd")], {
  cwd,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});

child.unref();
console.log(child.pid);
