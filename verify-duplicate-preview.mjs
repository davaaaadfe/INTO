import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const cwd = "C:/Users/inbod/Documents/Codex/2026-06-15/build-a-web-application-called-into";
const nodeBin = "C:/Users/inbod/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin";
const playwrightPath =
  "file:///C:/Users/inbod/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs";
const port = 3003;
const outputs = resolve(cwd, "outputs");
const fixtures = resolve(cwd, "work/e2e-fixtures");
mkdirSync(outputs, { recursive: true });
mkdirSync(fixtures, { recursive: true });

function escapePdfText(value) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function onePagePdf(title) {
  const stream = `BT /F1 18 Tf 72 720 Td (${escapePdfText(title)}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];

  for (const object of objects) {
    offsets.push(pdf.length);
    pdf += object;
  }

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return pdf;
}

const bookedDuplicateFile = resolve(fixtures, "duplicate-preview-office.pdf");
const processedDuplicateFile = resolve(fixtures, "duplicate-unbooked-google.pdf");
writeFileSync(bookedDuplicateFile, onePagePdf("INTO duplicate already booked invoice"));
writeFileSync(processedDuplicateFile, onePagePdf("INTO duplicate processed not booked invoice"));

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

async function uploadFile(page, filePath) {
  await page.locator('input[name="files"]').setInputFiles(filePath);
}

try {
  await waitForServer();
  const { chromium } = await import(playwrightPath);
  const browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const failedRequests = [];
  page.on("requestfailed", (request) => {
    if (!request.url().startsWith("chrome-extension://")) {
      failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ""}`);
    }
  });
  page.on("response", (response) => {
    if (!response.url().startsWith("chrome-extension://") && response.status() >= 500) {
      failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });

  for (const label of [
    "Auto-fit",
    "Fit width",
    "Fit height",
    "Zoom out",
    "Zoom in",
    "Rotate left",
    "Rotate right",
    "Reset view",
    "Fullscreen preview",
  ]) {
    await page.getByRole("button", { name: label }).first().waitFor();
  }

  await page.getByRole("button", { name: "Fit width" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByText(/Manual zoom - Zoom 110%/).waitFor();
  await page.getByRole("button", { name: "Rotate right" }).click();
  await page.getByText(/Rotated 90deg/).waitFor();
  await page.getByRole("button", { name: "Fullscreen preview" }).click();
  await page.getByRole("button", { name: "Exit fullscreen" }).waitFor();
  await page.getByRole("button", { name: "Exit fullscreen" }).click();
  await page.getByRole("button", { name: "Reset view" }).click();
  await page.getByText(/Auto-fit - Zoom 100%/).waitFor();

  await page.getByRole("button", { name: /^Connect Exact Online$/ }).click();
  await page.getByText(/Exact Online mock connection is active/).waitFor();

  await uploadFile(page, bookedDuplicateFile);
  await page.getByText("Processed 1 invoice file(s).").waitFor({ timeout: 20_000 });
  const bookedRow = page
    .locator("tbody tr")
    .filter({ hasText: "duplicate-preview-office.pdf" });
  await bookedRow.getByRole("button", { name: /^Book invoice$/ }).click();
  await page.getByText("Invoice booked into mock Exact Online.").waitFor();

  await uploadFile(page, bookedDuplicateFile);
  await page
    .getByText("This invoice has already been booked in Exact Online.", {
      exact: true,
    })
    .waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Show existing invoice" }).click();

  await uploadFile(page, processedDuplicateFile);
  await page.getByText("Processed 1 invoice file(s).").waitFor({ timeout: 20_000 });
  await uploadFile(page, processedDuplicateFile);
  await page
    .getByText(
      "This invoice was already processed but has not been booked in Exact Online yet. Do you want INTO to re-read it?",
      { exact: true }
    )
    .waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Keep existing processed invoice" }).click();
  await page.getByText("Existing processed invoice kept and highlighted.").waitFor();

  if (failedRequests.length) {
    throw new Error(`Failed browser requests:\n${failedRequests.join("\n")}`);
  }

  await page.screenshot({
    path: resolve(outputs, "into-duplicate-preview-verification.png"),
    fullPage: true,
  });
  await browser.close();
  writeFileSync(
    resolve(cwd, "work/verify-duplicate-preview-result.json"),
    JSON.stringify(
      {
        previewControls: true,
        alreadyBookedDuplicateBlocked: true,
        processedDuplicateDecision: true,
        screenshot: resolve(outputs, "into-duplicate-preview-verification.png"),
      },
      null,
      2
    )
  );
  console.log("Duplicate and preview verification passed.");
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
