import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { parseHTML } from "linkedom";
import { renderAcquisitionDetailCenter, type AcquisitionDetailCenterState } from "../src/acquisition/detail-center-view";

const frontend = fileURLToPath(new URL("..", import.meta.url));
const index = parseHTML(await readFile(resolve(frontend, "index.html"), "utf8")).document;
const dialog = index.querySelector("#replicaAcquisitionDetailCenter")!;
const styleRoot = process.argv.includes("--built") ? resolve(frontend, "dist-desktop") : frontend;
const styleIndex = parseHTML(await readFile(resolve(styleRoot, "index.html"), "utf8")).document;
const styles = await Promise.all(Array.from(styleIndex.querySelectorAll('link[rel="stylesheet"]'))
  .map(link => readFile(resolve(styleRoot, link.getAttribute("href")!.replace(/^\//, "")), "utf8")));
const candidate = { id: "candidate-layout", publicDisplayName: "今日原理", subjectKind: "individual",
  status: "normalized", identityResolved: true };
const latestRun = { id: "run-latest-empty", status: "cancelled" as const,
  updatedAt: "2026-09-10T06:00:00.000Z", completedAt: "2026-09-10T06:00:00.000Z",
  evidenceCount: 0, consumedBudget: { requests: 0, results: 0, amountMinor: 0, durationSeconds: 0 } };
const state: AcquisitionDetailCenterState = {
  mode: "candidates", status: "ready", message: null, error: null,
  selectedCandidateId: candidate.id,
  candidateFocus: { candidateId: candidate.id, runId: "run-retained", discoveredEventId: "event-retained" },
  candidateDetail: { candidate, evidence: [{ id: "evidence-layout", sourceTitle: "工业除尘",
    sourceSnippet: "9 月 5 日保留的工业除尘公开需求。", sourcePlatform: "douyin",
    sourceUrl: "https://www.douyin.com/video/7658615574506868006",
    rawArtifactHash: `sha256:${"a".repeat(64)}`, fetchedAt: "2026-09-05T14:08:07.350Z" }],
    qualification: null, financialValue: null, battleCard: null, reviews: [],
    intelligenceOperation: null, identityResolutionOperation: null, privateDomainHandoff: null },
  detail: {
    task: { id: "task-layout", planId: "plan-layout", name: "郑州", objective: "公开需求",
      platform: "douyin", discoveryMethods: ["public_search"], planStatus: "approved",
      latestRun, updatedAt: latestRun.updatedAt },
    plan: { id: "plan-layout", status: "approved" }, latestRun, shards: [],
    presentation: { providers: [], candidateEvents: [{ candidateId: candidate.id, candidate }] }
  }
};

// Isolated fixture only: no authenticated page, application scripts, server or business API.
const browser = await chromium.launch({ channel: "chrome", headless: true });
const observations: unknown[] = [];
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.abort());
  for (const width of [1280, 1536, 800, 520]) {
    await page.setViewportSize({ width, height: 900 });
    for (const focused of [true, false]) {
      const current = { ...state, candidateFocus: focused ? state.candidateFocus : null };
      await page.setContent(`<html><head><title>Shensi candidate layout test</title></head><body class="is-authenticated">${dialog.outerHTML}</body></html>`);
      for (const content of styles) await page.addStyleTag({ content });
      await page.locator("#replicaAcquisitionDetailCenterBody").evaluate((body, html) => {
        body.innerHTML = html;
        const modal = body.closest("dialog")!;
        modal.hidden = false;
        modal.showModal();
      }, renderAcquisitionDetailCenter(current));
      const layout = await page.locator(".replica-acquisition-candidate-layout").evaluate(element => {
        const inspector = element.querySelector<HTMLElement>(".replica-acquisition-candidate-inspector")!;
        const list = element.querySelector<HTMLElement>(".replica-acquisition-candidate-list");
        const bounds = element.getBoundingClientRect();
        const detailBounds = inspector.getBoundingClientRect();
        return {
          width: bounds.width, inspectorWidth: detailBounds.width,
          columns: getComputedStyle(element).gridTemplateColumns,
          inspectorMinWidth: getComputedStyle(inspector).minWidth,
          inspectorLeft: detailBounds.left, listRight: list?.getBoundingClientRect().right ?? null,
          overflow: inspector.scrollWidth > inspector.clientWidth + 1
        };
      });
      observations.push({ viewport: width, focused, ...layout });
      assert.ok(layout.width > 300, "the real dialog fixture must have a usable content width");
      if (focused || width <= 800) {
        assert.ok(Math.abs(layout.inspectorWidth - layout.width) <= 1,
          `${width}px ${focused ? "focused" : "ordinary mobile"}: inspector ${layout.inspectorWidth}px must fill ${layout.width}px; computed columns=${layout.columns}`);
      } else {
        assert.ok(layout.listRight !== null && layout.inspectorLeft > layout.listRight,
          "ordinary desktop candidate list must keep its separate left column");
        assert.ok(layout.inspectorWidth < layout.width - 200);
      }
      assert.equal(layout.inspectorMinWidth, "0px");
      assert.equal(layout.overflow, false, "evidence URLs and hashes must not create horizontal overflow");
      if (focused && width === 1280 && process.env.SHENSI_LAYOUT_SCREENSHOT) {
        await page.screenshot({ path: process.env.SHENSI_LAYOUT_SCREENSHOT, fullPage: false });
      }
    }
  }
  for (const size of [{ width: 1280, height: 800 }, { width: 800, height: 600 }, { width: 520, height: 640 }]) {
    await page.setViewportSize(size);
    const current: AcquisitionDetailCenterState = { ...state, handoffDialog: {
      open: true, busy: false, runId: "run-retained", discoveredEventId: "event-retained",
      decisionVersion: "", mode: "create_new", existingCustomerId: "",
      followUp: { title: "首次跟进：确认需求", dueAt: "2026-09-13T02:00:00.000Z", priority: "high" }
    } };
    await page.locator("#replicaAcquisitionDetailCenterBody").evaluate((body, html) => {
      body.innerHTML = html;
    }, renderAcquisitionDetailCenter(current));
    const form = page.locator('[data-acquisition-detail-form="private-domain-handoff"]');
    const layout = await form.evaluate(element => {
      const radio = element.querySelector('input[type="radio"]')!;
      const footer = element.querySelector('footer')!;
      return { nestedDialogs: element.closest('dialog')?.parentElement?.closest('dialog') !== null,
        radioWidth: radio.getBoundingClientRect().width, radioHeight: radio.getBoundingClientRect().height,
        background: getComputedStyle(element.parentElement!).backgroundColor,
        overflow: element.scrollWidth > element.clientWidth + 1,
        footerBottom: footer.getBoundingClientRect().bottom,
        tabs: Boolean(element.closest('.replica-acquisition-detail-body')?.querySelector('[role="tablist"]')) };
    });
    assert.equal(layout.nestedDialogs, false, "handoff must stay in the parent modal, not an unmodal nested dialog");
    assert.ok(layout.radioWidth <= 20 && layout.radioHeight <= 20, "radio cannot inherit full-width text input sizing");
    assert.notEqual(layout.background, "rgb(255, 255, 255)");
    assert.equal(layout.overflow, false);
    assert.ok(layout.footerBottom <= size.height, "confirmation footer remains in the viewport");
    assert.equal(layout.tabs, false, "candidate tabs cannot overlap the handoff form");
    assert.doesNotMatch(await form.innerText(), /run-retained|event-retained/);
    await form.locator('input[name="followUpTitle"]').fill("保留编辑中的跟进");
    await form.locator('input[value="link_existing"]').check();
    assert.equal(await form.locator('input[name="followUpTitle"]').inputValue(), "保留编辑中的跟进");
    await form.locator('input[value="create_new"]').check();
    await form.locator('button[type="submit"]').click({ trial: true });
    if (size.width === 1280 && process.env.SHENSI_HANDOFF_SCREENSHOT) {
      await page.screenshot({ path: process.env.SHENSI_HANDOFF_SCREENSHOT });
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, browser: "headless chrome", styleRoot, cases: observations.length, observations }));
} finally { await browser.close(); }
