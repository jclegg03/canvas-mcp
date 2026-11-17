require("dotenv").config();

const express = require("express");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const multer = require("multer");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb", strict: true }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

const {
  PORT = "8787",
  CANVAS_BASE_URL,
  CANVAS_COURSE_ID,
  CANVAS_KEYCHAIN_SERVICE = "canvas-submission-server",
  CANVAS_KEYCHAIN_ACCOUNT = "canvas-api-token",
  SERVER_API_KEY,
  SUBMISSION_CONFIRMATION_PHRASE
} = process.env;

let canvasApiToken;

function readCanvasTokenFromKeychain() {
  if (process.platform !== "darwin") {
    throw new Error("This server requires macOS Keychain and must run on macOS");
  }

  try {
    return execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-a", CANVAS_KEYCHAIN_ACCOUNT, "-s", CANVAS_KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  } catch {
    throw new Error(
      `Canvas token not found in Keychain (service: ${CANVAS_KEYCHAIN_SERVICE}, account: ${CANVAS_KEYCHAIN_ACCOUNT})`
    );
  }
}

function required(name, value) {
  if (!value) throw new Error(`${name} is not configured`);
}

function safeEqual(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireConfigured() {
  required("CANVAS_BASE_URL", CANVAS_BASE_URL);
  required("CANVAS_COURSE_ID", CANVAS_COURSE_ID);
  required("CANVAS_KEYCHAIN_SERVICE", CANVAS_KEYCHAIN_SERVICE);
  required("CANVAS_KEYCHAIN_ACCOUNT", CANVAS_KEYCHAIN_ACCOUNT);
  required("SERVER_API_KEY", SERVER_API_KEY);
  required("SUBMISSION_CONFIRMATION_PHRASE", SUBMISSION_CONFIRMATION_PHRASE);
  required("Canvas token from Keychain", canvasApiToken);
}

function requireLocalAuth(req, res, next) {
  if (!safeEqual(req.get("Authorization"), `Bearer ${SERVER_API_KEY}`)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function canvasUrl(path) {
  const base = new URL(CANVAS_BASE_URL);
  if (base.protocol !== "https:") {
    throw new Error("CANVAS_BASE_URL must use HTTPS");
  }
  return new URL(`/api/v1${path}`, base);
}

function canvasHeaders() {
  return {
    Authorization: `Bearer ${canvasApiToken}`,
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded"
  };
}

async function parseCanvasResponse(response) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 2000) }; }
  return { response, body };
}

async function uploadFileForSubmission(assignmentId, file) {
  const metadata = new URLSearchParams({
    name: file.originalname || "chat-transcript.txt",
    size: String(file.size),
    content_type: file.mimetype || "text/plain",
    on_duplicate: "rename"
  });

  const prepare = await fetch(
    canvasUrl(`/courses/${encodeURIComponent(CANVAS_COURSE_ID)}/assignments/${encodeURIComponent(assignmentId)}/submissions/self/files`),
    { method: "POST", headers: canvasHeaders(), body: metadata.toString() }
  );
  const prepared = await parseCanvasResponse(prepare);
  if (!prepare.ok || !prepared.body.upload_url || !prepared.body.upload_params) {
    const error = new Error("Canvas did not provide upload instructions");
    error.status = prepare.status;
    error.canvasBody = prepared.body;
    throw error;
  }

  const uploadForm = new FormData();
  for (const [key, value] of Object.entries(prepared.body.upload_params)) {
    uploadForm.append(key, String(value));
  }
  uploadForm.append("file", new Blob([file.buffer], { type: file.mimetype || "text/plain" }), file.originalname || "chat-transcript.txt");

  const transfer = await fetch(prepared.body.upload_url, {
    method: "POST",
    body: uploadForm,
    redirect: "manual"
  });
  const location = transfer.headers.get("location");
  if (![201, 301, 302, 303, 307, 308].includes(transfer.status) || !location) {
    const transferBody = await transfer.text();
    const error = new Error("Canvas file transfer did not return a completion location");
    error.status = transfer.status;
    error.canvasBody = { raw: transferBody.slice(0, 2000) };
    throw error;
  }

  const complete = await fetch(location, {
    method: "GET",
    headers: { Authorization: `Bearer ${canvasApiToken}`, Accept: "application/json" }
  });
  const completed = await parseCanvasResponse(complete);
  if (!complete.ok || !completed.body.id) {
    const error = new Error("Canvas did not confirm the uploaded file");
    error.status = complete.status;
    error.canvasBody = completed.body;
    throw error;
  }
  return completed.body.id;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, configured: Boolean(
    CANVAS_BASE_URL && CANVAS_COURSE_ID && canvasApiToken &&
    SERVER_API_KEY && SUBMISSION_CONFIRMATION_PHRASE
  ) });
});

// The only Canvas write operation exposed by this server.
app.post("/v1/submit", requireLocalAuth, upload.single("file"), async (req, res) => {
  try {
    requireConfigured();

    if (!safeEqual(req.get("X-Submission-Confirmation"), SUBMISSION_CONFIRMATION_PHRASE)) {
      return res.status(428).json({
        error: "Explicit confirmation required",
        detail: "Repeat the request only after the user has confirmed the exact submission."
      });
    }

    const { assignment_id: assignmentId, submission_type: submissionType, body, url, file_ids: fileIds } = req.body || {};
    if (!/^\d+$/.test(String(assignmentId || ""))) {
      return res.status(400).json({ error: "assignment_id must be a numeric Canvas assignment ID" });
    }

    const allowedTypes = new Set(["online_text_entry", "online_url", "online_upload"]);
    if (!allowedTypes.has(submissionType)) {
      return res.status(400).json({ error: "submission_type must be online_text_entry, online_url, or online_upload" });
    }

    const submission = new URLSearchParams();
    submission.set("submission[submission_type]", submissionType);
    if (submissionType === "online_text_entry") {
      if (typeof body !== "string" || body.length === 0 || body.length > 1_000_000) {
        return res.status(400).json({ error: "body must be a non-empty string of at most 1,000,000 characters" });
      }
      submission.set("submission[body]", body);
    }
    if (submissionType === "online_url") {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: "url must be an http(s) URL" });
      }
      submission.set("submission[url]", url);
    }
    if (submissionType === "online_upload") {
      let submissionFileIds = fileIds;
      if (req.file) {
        submissionFileIds = [await uploadFileForSubmission(assignmentId, req.file)];
      }
      if (typeof submissionFileIds === "string") submissionFileIds = [submissionFileIds];
      if (!Array.isArray(submissionFileIds) || submissionFileIds.length === 0 || !submissionFileIds.every((id) => /^\d+$/.test(String(id)))) {
        return res.status(400).json({ error: "Provide one uploaded file or a non-empty array of numeric file_ids" });
      }
      submissionFileIds.forEach((id) => submission.append("submission[file_ids][]", String(Number(id))));
    }

    const response = await fetch(
      canvasUrl(`/courses/${encodeURIComponent(CANVAS_COURSE_ID)}/assignments/${encodeURIComponent(assignmentId)}/submissions`),
      { method: "POST", headers: canvasHeaders(), body: submission.toString() }
    );

    const text = await response.text();
    let canvasBody;
    try { canvasBody = JSON.parse(text); } catch { canvasBody = { raw: text.slice(0, 2000) }; }
    return res.status(response.status).json(canvasBody);
  } catch (error) {
    console.error("Submission request failed:", error.message);
    return res.status(error.status || 500).json({
      error: error.message,
      ...(error.canvasBody ? { canvas: error.canvasBody } : {})
    });
  }
});

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

try {
  canvasApiToken = readCanvasTokenFromKeychain();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

app.listen(Number(PORT), "127.0.0.1", () => {
  console.log(`Canvas submission server listening on http://127.0.0.1:${PORT}`);
});
