/**
 * E2E Usability Test: Two browser clients + signaling server
 *
 * Flow:
 *   1. Client A (host) creates a room
 *   2. Client B (guest) joins using the room code
 *   3. Both clients reach "Connected" P2P state
 */

import puppeteer from "puppeteer-core";
import { execSync, spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SCREENSHOT_DIR = path.join(__dirname, "screenshots");
const CHROMIUM_PATH = "/etc/profiles/per-user/lluz/bin/chromium";
const SERVER_PORT = 18080;
const FRONTEND_PORT = 18081;
const FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
const WS_URL = `ws://127.0.0.1:${SERVER_PORT}/ws`;

mkdirSync(SCREENSHOT_DIR, { recursive: true });

let serverProc = null;
let frontendProc = null;

function log(tag, msg) {
  const ts = new Date().toISOString().substring(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function screenshot(page, label) {
  const file = path.join(SCREENSHOT_DIR, `${label}.png`);
  await page.screenshot({ path: file, fullPage: false });
  log("screenshot", label);
}

async function startServer() {
  log("server", `starting signaling server on :${SERVER_PORT}`);
  serverProc = spawn(
    path.join(ROOT, "server/p2pshare-server"),
    ["--port", String(SERVER_PORT)],
    { stdio: "pipe" }
  );
  serverProc.stderr.on("data", (d) =>
    log("server:err", d.toString().trim())
  );
  serverProc.stdout.on("data", (d) =>
    log("server:out", d.toString().trim())
  );
  await sleep(400);
}

async function startFrontend() {
  log("frontend", `serving web on :${FRONTEND_PORT}`);
  frontendProc = spawn(
    "npx",
    ["--yes", "http-server", path.join(ROOT, "web"), "-p", String(FRONTEND_PORT)],
    { stdio: "pipe" }
  );
  frontendProc.stderr.on("data", (d) => {});
  await sleep(1000);
}

function stopAll() {
  if (serverProc) serverProc.kill();
  if (frontendProc) frontendProc.kill();
}

async function openBrowser(label) {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });

  // Inject signaling URL override before page load
  await page.evaluateOnNewDocument((wsUrl) => {
    window.__SIGNALING_URL__ = wsUrl;
  }, WS_URL);

  page._label = label;
  log(label, "browser launched");
  return { browser, page };
}

async function waitForStatus(page, label, targetText, timeoutMs = 12000) {
  log(label, `waiting for status: "${targetText}"`);
  const start = Date.now();
  const targets = Array.isArray(targetText) ? targetText : [targetText];
  while (Date.now() - start < timeoutMs) {
    const text = await page.$eval("#status-text", (el) => el.textContent).catch(() => "");
    if (targets.some(t => text.toLowerCase().includes(t.toLowerCase()))) {
      log(label, `status reached: "${text}"`);
      return text;
    }
    await sleep(200);
  }
  const current = await page.$eval("#status-text", (el) => el.textContent).catch(() => "(none)");
  throw new Error(`Timeout waiting for "${targetText}". Current: "${current}"`);
}

async function runTest() {
  log("test", "=== P2P Share Usability Test ===");

  await startServer();
  await startFrontend();

  let clientA, clientB;

  try {
    // -- Open two clients
    clientA = await openBrowser("client-A");
    clientB = await openBrowser("client-B");

    // -- Client A: navigate and create room
    log("client-A", `navigating to ${FRONTEND_URL}`);
    await clientA.page.goto(FRONTEND_URL, { waitUntil: "networkidle0" });
    await screenshot(clientA.page, "01-clientA-lobby");

    log("client-A", "clicking 'Create a Secure Room'");
    await clientA.page.click("#create-room-btn");
    await sleep(600);
    await screenshot(clientA.page, "02-clientA-room-created");

    const roomCode = await clientA.page.$eval("#room-code-text", (el) => el.textContent.trim());
    log("client-A", `room code: "${roomCode}"`);

    if (!roomCode || roomCode === "...") {
      throw new Error("Room code not set after createRoom — signaling may have failed");
    }

    await waitForStatus(clientA.page, "client-A", ["Waiting for peers", "Connecting (serverless)"]);
    await screenshot(clientA.page, "03-clientA-waiting");

    // -- Client B: navigate, enter room code, join
    log("client-B", `navigating to ${FRONTEND_URL}`);
    await clientB.page.goto(FRONTEND_URL, { waitUntil: "networkidle0" });
    await screenshot(clientB.page, "04-clientB-lobby");

    log("client-B", `entering room code: "${roomCode}"`);
    await clientB.page.click("#join-room-input");
    await clientB.page.type("#join-room-input", roomCode);
    await screenshot(clientB.page, "05-clientB-code-entered");

    log("client-B", "clicking 'Join Room'");
    await clientB.page.click("#join-room-btn");
    await sleep(800);
    await screenshot(clientB.page, "06-clientB-joining");

    // -- Wait for WebRTC connection on both sides
    log("test", "waiting for P2P connection...");
    const [statusA, statusB] = await Promise.all([
      waitForStatus(clientA.page, "client-A", "Connected", 20000),
      waitForStatus(clientB.page, "client-B", "Connected", 20000),
    ]);

    await screenshot(clientA.page, "07-clientA-connected");
    await screenshot(clientB.page, "08-clientB-connected");

    // -- Report
    log("test", "");
    log("test", "=== RESULT: PASS ===");
    log("test", `client-A status: "${statusA}"`);
    log("test", `client-B status: "${statusB}"`);
    log("test", `screenshots saved to: ${SCREENSHOT_DIR}`);

    // -- Check for errors in banners
    const errorA = await clientA.page.$eval("#error-banner", (el) =>
      el.style.display !== "none" ? el.textContent : ""
    ).catch(() => "");
    const errorB = await clientB.page.$eval("#error-banner", (el) =>
      el.style.display !== "none" ? el.textContent : ""
    ).catch(() => "");

    if (errorA) log("client-A", `ERROR BANNER: ${errorA}`);
    if (errorB) log("client-B", `ERROR BANNER: ${errorB}`);

  } catch (err) {
    log("test", `=== RESULT: FAIL ===`);
    log("test", `Error: ${err.message}`);
    if (clientA?.page) await screenshot(clientA.page, "FAIL-clientA").catch(() => {});
    if (clientB?.page) await screenshot(clientB.page, "FAIL-clientB").catch(() => {});
    process.exitCode = 1;
  } finally {
    await clientA?.browser?.close();
    await clientB?.browser?.close();
    stopAll();
  }
}

runTest();
