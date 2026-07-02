import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const cwd = "C:/Users/inbod/Documents/Codex/2026-06-15/build-a-web-application-called-into";
const nodeBin = "C:/Users/inbod/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin";
const playwrightPath =
  "file:///C:/Users/inbod/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs";
const outputs = resolve(cwd, "outputs");
const port = 3001;
mkdirSync(outputs, { recursive: true });

const env = {
  ...process.env,
  Path: `${resolve(cwd, "work/npm-bin")};${nodeBin};${process.env.Path ?? ""}`,
  npm_config_cache: resolve(cwd, "work/npm-cache"),
  XDG_CONFIG_HOME: resolve(cwd, "work/xdg-config"),
  XDG_CACHE_HOME: resolve(cwd, "work/xdg-cache"),
  WRANGLER_HOME: resolve(cwd, "work/wrangler-home"),
  APPDATA: resolve(cwd, "work/appdata"),
  LOCALAPPDATA: resolve(cwd, "work/localappdata"),
};

const child = spawn("cmd.exe", [
  "/d",
  "/c",
  `${resolve(cwd, "work/npm-bin/npm.cmd")} run dev -- --host 127.0.0.1 --port ${port}`,
], {
  cwd,
  env,
  windowsHide: true,
});

let logs = "";
let success = false;
child.stdout.on("data", (chunk) => {
  logs += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  logs += chunk.toString();
});

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 45_000) {
    try {
      const response = await fetch(`http://localhost:${port}`);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 750));
    }
  }

  throw new Error(`Server did not respond in time.\n${logs}`);
}

try {
  await waitForServer();
  const { chromium } = await import(playwrightPath);
  const browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const failedRequests = [];
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ""}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });
  const diagnostics = await page.evaluate(() => ({
    links: [...document.querySelectorAll("link")].map((link) => ({
      rel: link.getAttribute("rel"),
      href: link.getAttribute("href"),
    })),
    sheets: [...document.styleSheets].map((sheet) => {
      let ruleCount = -1;
      try {
        ruleCount = sheet.cssRules.length;
      } catch {
        ruleCount = -2;
      }
      return { href: sheet.href, ruleCount };
    }),
    mainBackground: getComputedStyle(document.querySelector("main")).backgroundColor,
    bodyText: document.body.innerText.slice(0, 500),
  }));
  writeFileSync(
    resolve(cwd, "work/verify-ui-diagnostics.json"),
    JSON.stringify({ diagnostics, failedRequests }, null, 2)
  );
  await page.waitForFunction(() => {
    const main = document.querySelector("main");
    return main && getComputedStyle(main).backgroundColor === "rgb(246, 247, 244)";
  });
  await page.waitForFunction(() =>
    document.body.innerText.includes("Noordzee Office Supplies")
  );
  await page.screenshot({
    path: resolve(outputs, "into-preview-desktop.png"),
    fullPage: true,
  });

  const visibleText = await page.locator("body").innerText();
  const requiredText = [
    "INTO",
    "Invoice booking automation",
    "Bulk upload",
    "Invoice queue",
    "Review invoice",
    "Exact Online",
    "Outlook ingestion",
  ];
  const missing = requiredText.filter((text) => !visibleText.includes(text));
  if (missing.length) {
    throw new Error(`Missing expected UI text: ${missing.join(", ")}`);
  }
  if (failedRequests.length) {
    throw new Error(`Failed browser requests:\n${failedRequests.join("\n")}`);
  }

  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({
    path: resolve(outputs, "into-preview-mobile.png"),
    fullPage: true,
  });
  await browser.close();
  writeFileSync(resolve(cwd, "work/verify-ui.log"), "UI verification passed.\n");
  console.log("UI verification passed.");
  success = true;
} finally {
  if (child.pid && child.exitCode === null) {
    try {
      execFileSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
      });
    } catch {
      child.kill();
    }
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

if (success) {
  process.exit(0);
}
