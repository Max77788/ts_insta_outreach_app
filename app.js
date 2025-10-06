// server.js
import fs from "fs";
import path from "path";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import dotenv from "dotenv";
import readlineSync from "readline-sync";
import {
  IgApiClient,
  IgCheckpointError,
  IgLoginTwoFactorRequiredError,
} from "instagram-private-api";
import { search_insta_profiles } from "./apify_module.js";
import { fileURLToPath } from "url";

// If you're on Node <18 uncomment the next line:
// import fetch from "node-fetch";

// Paths from your mount-aware config
import { COOKIES_PATH_, LEDGER_PATH_ } from "./config/paths.js";

dotenv.config();

/* ===================== Config ===================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const COOKIES_PATH = COOKIES_PATH_ || "./stuff_folder/ig.cookies.json";
const LEDGER_PATH = LEDGER_PATH_ || "./stuff_folder/ig.already_contacted.json";
// Persist job states alongside the ledger by default:
const JOBS_PATH =
  process.env.JOBS_PATH || path.join(path.dirname(LEDGER_PATH), "ig.jobs.json");

const DEVICE_SEED = process.env.IG_DEVICE_SEED || "stable-device-seed";
const IG_USER = process.env.IG_USER;
const IG_PASS = process.env.IG_PASS;
const PROXY_URL = process.env.IG_PROXY_URL || ""; // optional

/* ================== Basic Guards ================== */
if (!IG_USER || !IG_PASS) {
  console.error("Missing IG_USER or IG_PASS in environment.");
  process.exit(1);
}

/* ================== Helpers ================== */
function ensureDirFor(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirFor(COOKIES_PATH);
ensureDirFor(LEDGER_PATH);
ensureDirFor(JOBS_PATH);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function rand(a, b) {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

/* ============== Ledger (persisted) ============== */
function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")));
  } catch {
    return new Set();
  }
}
function saveLedger(set) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify([...set]));
}

/* ============== Jobs (persisted) ============== */
function loadJobs() {
  if (!fs.existsSync(JOBS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(JOBS_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}
function saveJobs(jobs) {
  // simple atomic-ish write
  const tmp = JOBS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(jobs));
  fs.renameSync(tmp, JOBS_PATH);
}
const jobs = loadJobs();
let jobCounter = Object.keys(jobs).length;

/* =================== IG Client ==================== */
const ig = new IgApiClient();
ig.state.generateDevice(DEVICE_SEED);

async function saveState() {
  const state = await ig.state.serialize();
  delete state.constants;
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(state));
}
async function restoreStateIfExists() {
  if (fs.existsSync(COOKIES_PATH)) {
    await ig.state.deserialize(
      JSON.parse(fs.readFileSync(COOKIES_PATH, "utf8"))
    );
    return true;
  }
  return false;
}

const getCode = async (label) => readlineSync.question(`${label} `);

async function loginOnce() {
  console.log("[IG] Logging in…");

  ig.state.generateDevice(IG_USER);
  if (PROXY_URL) ig.state.proxyUrl = PROXY_URL;

  const restored = await restoreStateIfExists();
  if (restored) {
    try {
      await ig.account.currentUser();
      console.log("[IG] Session restored.");
      return;
    } catch {
      console.log("[IG] Stored session invalid; re-authenticating…");
    }
  }

  await ig.simulate.preLoginFlow();

  try {
    const user = await ig.account.login(IG_USER, IG_PASS);
    console.log("[IG] Logged in as", user.username);
    await saveState();
    return;
  } catch (err) {
    if (err instanceof IgLoginTwoFactorRequiredError) {
      const info = err.response.body.two_factor_info;
      const useTotp = info.totp_two_factor ? "0" : "1"; // 0=TOTP, 1=SMS
      const code = await getCode(
        `Enter ${info.totp_two_factor ? "TOTP" : "SMS"} code sent to ${
          info.obfuscated_phone_number ?? "your device"
        }:`
      );

      const user = await ig.account.twoFactorLogin({
        username: IG_USER,
        verificationCode: code,
        twoFactorIdentifier: info.two_factor_identifier,
        verificationMethod: useTotp,
        trustThisDevice: "1",
      });

      console.log("[IG] 2FA success. Logged in as", user.username);
      await saveState();
      return;
    }

    if (err instanceof IgCheckpointError) {
      await ig.challenge.auto(true).catch(() => {});
      const ch = await ig.challenge.state();
      if (!ch.step_name && ch.step_data?.choice === undefined) {
        const method = ch.step_data?.email ? "email" : "phone";
        try {
          await ig.challenge.selectVerifyMethod(method);
        } catch {}
      }
      const contact = ch.step_data?.contact_point ?? "your device";
      const code = await getCode(`Enter the security code sent to ${contact}:`);
      await ig.challenge.sendSecurityCode(code);
      await saveState();
      console.log("[IG] Checkpoint resolved and session saved.");
      return;
    }

    throw err;
  }
}

/* ============== Domain Actions ============== */
async function searchProfiles(query, limit = 5) {
  const results = await ig.user.search(query);
  return results.slice(0, limit);
}

async function sendDmToUser(userId, text) {
  const thread = ig.entity.directThread([userId.toString()]);
    await sleep(rand(1200, 3000));
    console.log("[IG] Sending DM to", userId);
  return thread.broadcastText(text);
}

/* ============== Job Runner (background) ============== */
async function runInstaJob(jobId, term, opts) {
  const {
    dryRun = false,
    maxTargets = 10,
    minDelayMs = 90_000,
    maxDelayMs = 120_000,
  } = opts;

  const report = {
    term,
    dryRun: !!dryRun,
    maxTargets,
    attempted: 0,
    skipped_existing: 0,
    sent: 0,
    failures: 0,
    targetsProcessed: [],
    startedAt: new Date().toISOString(),
  };

  try {
    jobs[jobId].status = "authenticating";
    saveJobs(jobs);
    await loginOnce();

    const ledger = loadLedger();

    jobs[jobId].status = "searching";
    saveJobs(jobs);
    const searchResults = await search_insta_profiles(term);
    const candidates = (searchResults?.[0]?.topPosts || []).slice(
      0,
      maxTargets
    );

    jobs[jobId].status = "messaging";
    saveJobs(jobs);

    for (const t of candidates) {
      const ownerId = String(t.ownerId);
      const ownerUsername = t.ownerUsername;
      const firstName =
        (t.ownerFullName || "").split(" ")[0]?.toLowerCase() || "there";

      if (ledger.has(ownerId)) {
        report.skipped_existing++;
        report.targetsProcessed.push({
          ownerId,
          ownerUsername,
          status: "skipped_already_contacted",
        });
        continue;
      }

      const msg = `hi ${firstName}, i doubt you will see this but I recently added that exercise you posted to my routine... it has helped a lot, allowing me to fit in a bit more and fit in clothes :) keep up the great work, love your content!!🍉`;

      try {
        report.attempted++;
        if (!dryRun) {
          await sendDmToUser(ownerId, msg);
          ledger.add(ownerId);
          saveLedger(ledger);
        }
        report.sent += dryRun ? 0 : 1;
        report.targetsProcessed.push({
          ownerId,
          ownerUsername,
          status: dryRun ? "dry_run_ok" : "dm_sent",
        });

        jobs[jobId].report = report;
        saveJobs(jobs);

        const wait = rand(minDelayMs, maxDelayMs);
        await sleep(wait);
      } catch (e) {
        report.failures++;
        report.targetsProcessed.push({
          ownerId,
          ownerUsername,
          status: "failed",
          error: String(e?.message || e),
        });

        jobs[jobId].report = report;
        saveJobs(jobs);
      }
    }

    report.finishedAt = new Date().toISOString();
    report.durationSec =
      (new Date(report.finishedAt) - new Date(report.startedAt)) / 1000;

    jobs[jobId].status = "done";
    jobs[jobId].report = report;
    saveJobs(jobs);
  } catch (err) {
    jobs[jobId].status = "error";
    jobs[jobId].error = String(err?.message || err);
    jobs[jobId].report = jobs[jobId].report || null;
    saveJobs(jobs);
  }
}

/* =================== Express App =================== */
const app = express();

app.use(helmet());
app.use(cors({ origin: "*", methods: ["POST", "GET"] }));
app.use(express.json({ limit: "200kb" }));

const limiter = rateLimit({ windowMs: 60_000, max: 30 });
app.use(limiter);

app.get("/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

/**
 * POST /dm/search
 * Body: { term: string, dryRun?, maxTargets?, minDelayMs?, maxDelayMs? }
 * Returns: { ok, jobId, checkStatusAt }
 */
app.post("/dm/search", (req, res) => {
  const { term, ...opts } = req.body || {};

  if (!term || typeof term !== "string" || term.trim().length < 2) {
    return res
      .status(400)
      .json({
        error: 'Invalid or missing "term". Provide a non-empty string.',
      });
  }
  if (
    typeof opts.minDelayMs === "number" &&
    typeof opts.maxDelayMs === "number" &&
    opts.minDelayMs > opts.maxDelayMs
  ) {
    return res
      .status(400)
      .json({ error: '"minDelayMs" must be <= "maxDelayMs".' });
  }

  const jobId = `job_${++jobCounter}_${Date.now()}`;
  jobs[jobId] = {
    status: "queued",
    createdAt: new Date().toISOString(),
    report: null,
  };
  saveJobs(jobs);

  // fire-and-forget background execution
  runInstaJob(jobId, term, opts);

  return res.json({
    ok: true,
    message: "Job started",
    jobId,
    checkStatusAt: `/dm/status/${jobId}`,
  });
});

/** GET /dm/status/:id -> { status, report?, error? } */
app.get("/dm/status/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

/** GET /dm/jobs -> recent jobs (ids + status) */
app.get("/dm/jobs", (_req, res) => {
  const out = Object.entries(jobs)
    .sort((a, b) => (a[1].createdAt > b[1].createdAt ? -1 : 1))
    .slice(0, 50)
    .map(([id, j]) => ({ id, status: j.status, createdAt: j.createdAt }));
  res.json(out);
});

/** POST /dm/cancel/:id -> best-effort cancel flag (cooperative) */
const cancelFlags = new Set();
app.post("/dm/cancel/:id", (req, res) => {
  const { id } = req.params;
  if (!jobs[id]) return res.status(404).json({ error: "Job not found" });
  cancelFlags.add(id);
  jobs[id].status = "cancelling";
  saveJobs(jobs);
  res.json({ ok: true, message: "Cancellation requested" });
});

/* =================== Startup & Signals =================== */
const server = app.listen(PORT, () => {
  console.log(`API up on http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down…`);
  server.close(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/* ============== Cooperative cancel (optional) ============== */
/* If you want cancellation to stop mid-loop, sprinkle this in runInstaJob loop:
   if (cancelFlags.has(jobId)) { jobs[jobId].status = "cancelled"; saveJobs(jobs); return; }
*/
