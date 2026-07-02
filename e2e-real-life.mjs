import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const cwd = "C:/Users/inbod/Documents/Codex/2026-06-15/build-a-web-application-called-into";
const nodeBin = "C:/Users/inbod/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin";
const playwrightPath =
  "file:///C:/Users/inbod/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs";
const port = 3002;
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

const fixtureFiles = [
  "google-reverse-subscription.pdf",
  "ambiguous-acme.pdf",
  "payment-immediate.pdf",
  "inbody-internal.pdf",
  "klm-flight-david.pdf",
].map((fileName) => {
  const path = resolve(fixtures, fileName);
  writeFileSync(path, onePagePdf(`INTO source invoice ${fileName}`));
  return path;
});

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

async function clickRowByFile(page, fileName) {
  const rowButton = page.getByRole("button", { name: new RegExp(fileName, "i") }).first();
  await rowButton.click();
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
    if (request.url().startsWith("chrome-extension://")) {
      return;
    }
    failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ""}`);
  });
  page.on("response", (response) => {
    if (response.url().startsWith("chrome-extension://")) {
      return;
    }
    if (response.status() >= 500) {
      failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Connect Exact Online$/ }).click();
  await page.getByText(/Exact Online mock connection is active/).waitFor();

  await page.locator('input[name="files"]').setInputFiles(fixtureFiles);
  await page.getByText("Processed 5 invoice file(s).").waitFor({ timeout: 20_000 });

  const bodyAfterUpload = await page.locator("body").innerText();
  const expectedUploadSignals = [
    "Supplier Review Required",
    "Payment Condition Review Required",
    "Ready to Book",
    "Purchase Journal intelligence",
    "VAT code",
    "Attachment",
  ];
  const missingUploadSignals = expectedUploadSignals.filter(
    (text) => !bodyAfterUpload.includes(text)
  );
  if (missingUploadSignals.length) {
    writeFileSync(resolve(cwd, "work/e2e-real-life-upload-text.txt"), bodyAfterUpload);
    await page.screenshot({
      path: resolve(outputs, "into-real-life-upload-debug.png"),
      fullPage: true,
    });
    throw new Error(`Missing upload signals: ${missingUploadSignals.join(", ")}`);
  }

  await clickRowByFile(page, "ambiguous-acme.pdf");
  const acmeSupplierButton = page.getByRole("button", {
    name: /73001 - Acme Supplies BV - Amsterdam/i,
  });
  await acmeSupplierButton.waitFor();
  await acmeSupplierButton.click();
  await page.getByText("Supplier decision saved").waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("tbody tr")].some(
      (row) =>
        row.textContent?.includes("ambiguous-acme.pdf") &&
        row.textContent.includes("Ready to Book")
    )
  );

  await clickRowByFile(page, "payment-immediate.pdf");
  const approveButton = page.getByRole("button", { name: /^Approve intelligence$/ });
  await approveButton.waitFor();
  await approveButton.click();
  await page.getByText("Purchase Journal intelligence approved.").waitFor();

  const readyBookButtons = page.getByRole("button", { name: /^Book invoice$/ });
  const readyCount = await readyBookButtons.count();
  let booked = false;
  for (let index = 0; index < readyCount; index += 1) {
    const button = readyBookButtons.nth(index);
    if (await button.isEnabled()) {
      await button.click();
      await page.getByText("Invoice booked into mock Exact Online.").waitFor();
      booked = true;
      break;
    }
  }

  if (!booked) {
    throw new Error("No enabled Book invoice button was found after review fixes.");
  }

  const finalText = await page.locator("body").innerText();
  const expectedFinalSignals = [
    "Booked",
    "Journal",
    "Confidence",
    "Ready to upload with booking",
  ];
  const missingFinalSignals = expectedFinalSignals.filter(
    (text) => !finalText.includes(text)
  );
  if (missingFinalSignals.length) {
    throw new Error(`Missing final signals: ${missingFinalSignals.join(", ")}`);
  }

  if (failedRequests.length) {
    throw new Error(`Failed browser requests:\n${failedRequests.join("\n")}`);
  }

  await page.screenshot({
    path: resolve(outputs, "into-real-life-e2e.png"),
    fullPage: true,
  });
  await browser.close();

  const summary = {
    uploadedFiles: fixtureFiles.map((file) => file.split(/[\\/]/).pop()),
    checkedSignals: [...expectedUploadSignals, ...expectedFinalSignals],
    bookedInvoice: true,
    screenshot: resolve(outputs, "into-real-life-e2e.png"),
  };
  writeFileSync(resolve(cwd, "work/e2e-real-life-result.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
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
