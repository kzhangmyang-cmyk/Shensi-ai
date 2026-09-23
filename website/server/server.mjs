import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, extname, sep } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { validateInquiry } from "../src/contact-validation.mjs";

const requireBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
const root = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8" };

export function createMailDelivery(env) {
  const required = ["WEBSITE_SMTP_HOST", "WEBSITE_SMTP_USER", "WEBSITE_SMTP_PASSWORD", "WEBSITE_MAIL_FROM", "WEBSITE_MAIL_TO"];
  if (required.some(key => !env[key])) return null;
  const port = Number(env.WEBSITE_SMTP_PORT || "465");
  if (![465, 587].includes(port)) throw new Error("WEBSITE_SMTP_PORT must be 465 or 587");
  const transport = requireBackend("nodemailer").createTransport({
    host: env.WEBSITE_SMTP_HOST, port, secure: port === 465, requireTLS: true,
    auth: { user: env.WEBSITE_SMTP_USER, pass: env.WEBSITE_SMTP_PASSWORD },
    connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    disableFileAccess: true, disableUrlAccess: true,
  });
  return async (inquiry, id) => {
    const result = await transport.sendMail({
      from: env.WEBSITE_MAIL_FROM, to: env.WEBSITE_MAIL_TO,
      replyTo: inquiry.email, subject: `[SHENSI website] ${inquiry.need} · ${id}`,
      text: `Reference: ${id}\nLanguage: ${inquiry.locale}\nName: ${inquiry.name}\nCompany: ${inquiry.company}\nEmail: ${inquiry.email}\nIndustry: ${inquiry.industry}\nNeed: ${inquiry.need}\nConsent: reply to this inquiry only\n\n${inquiry.message}`,
    });
    if (!result.accepted?.length || result.rejected?.length) throw new Error("MAIL_NOT_ACCEPTED");
  };
}

// CRM integration point: inject a reviewed adapter at composition time.
// There is no outbound CRM request or contact database by default.
export function createWebsiteServer({ deliver = null, syncCrm = null, origins = [], now = Date.now } = {}) {
  const attempts = new Map();
  const json = (res, status, value) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname); } catch { return json(res, 400, { error: "bad_request" }); }
    if (pathname === "/api/website-contact") {
      if (req.method !== "POST") { res.setHeader("Allow", "POST"); return json(res, 405, { error: "method_not_allowed" }); }
      if (!origins.includes(req.headers.origin)) return json(res, 403, { error: "origin_rejected" });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) return json(res, 415, { error: "json_required" });
      const time = now();
      for (const [key, entry] of attempts) if (time - entry.start > 600000) attempts.delete(key);
      const ip = req.socket.remoteAddress || "unknown"; // Never trust arbitrary forwarded headers.
      const entry = attempts.get(ip) || { start: time, count: 0 };
      if (entry.count >= 5 || attempts.size > 10000) { res.setHeader("Retry-After", "600"); return json(res, 429, { error: "rate_limited" }); }
      entry.count++; attempts.set(ip, entry);
      const chunks = [];
      let bytes = 0;
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 16384) { json(res, 413, { error: "body_too_large" }); req.resume(); return; }
          chunks.push(chunk);
        }
      } catch { return json(res, 400, { error: "bad_request" }); }
      let raw;
      try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(res, 400, { error: "invalid_json" }); }
      const result = validateInquiry(raw);
      if (!result.ok) return json(res, 422, { error: "validation_failed", field: result.field });
      if (!deliver) return json(res, 503, { error: "delivery_unavailable" });
      const id = randomUUID();
      try { await deliver(result.value, id); } catch { return json(res, 502, { error: "delivery_failed" }); }
      // Mail is the primary receipt. A CRM failure must never cause a duplicate mail retry.
      if (syncCrm) { try { await syncCrm({ id, ...result.value }); } catch { /* Adapter owns redacted retry/monitoring. */ } }
      return json(res, 200, { status: "sent", reference: id });
    }
    if (!["GET", "HEAD"].includes(req.method || "")) return json(res, 405, { error: "method_not_allowed" });
    const target = resolve(root, `.${pathname.endsWith("/") ? pathname + "index.html" : extname(pathname) ? pathname : pathname + "/index.html"}`);
    if (!target.startsWith(root + sep) || pathname.includes("\0")) return json(res, 404, { error: "not_found" });
    try {
      const content = await readFile(target);
      res.writeHead(200, { "Content-Type": mime[extname(target)] || "application/octet-stream", "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=3600" : "no-cache" });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Page not found / 页面不存在"); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.WEBSITE_PORT || "5691");
  const origins = (process.env.WEBSITE_ALLOWED_ORIGINS || "http://127.0.0.1:5690,http://127.0.0.1:5691").split(",").map(s => s.trim());
  const server = createWebsiteServer({ deliver: createMailDelivery(process.env), origins });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.listen(port, "127.0.0.1", () => console.log(`SHENSI_WEBSITE http://127.0.0.1:${port}`));
}
