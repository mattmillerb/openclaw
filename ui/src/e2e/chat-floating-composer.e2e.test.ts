import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  chatThreadDistanceFromBottom,
  createChatFlowE2eSuite,
  installMockGateway,
  scrollChatThreadToTop,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const proofStage = process.env.OPENCLAW_FLOATING_COMPOSER_PROOF_STAGE?.trim() || "proposed";

async function setThemeMode(page: Page, mode: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.classList.toggle("wa-light", nextMode === "light");
    root.classList.toggle("wa-dark", nextMode === "dark");
    root.style.colorScheme = nextMode;
  }, mode);
}

async function captureProof(page: Page, theme: "dark" | "light", state: string) {
  if (!artifactDir) {
    return;
  }
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(artifactDir, `${proofStage}-${theme}-${state}-context.png`),
  });
  await page.locator(".chat-main__conversation").screenshot({
    animations: "disabled",
    path: path.join(artifactDir, `${proofStage}-${theme}-${state}-conversation.png`),
  });
}

suite.define(() => {
  it.each(["dark", "light"] as const)(
    "floats the complete composer dock over a reachable transcript in %s mode",
    async (theme) => {
      const context = await suite.newBrowserContext({
        colorScheme: theme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      });
      const page = await context.newPage();
      const baseTs = Date.now() - 100_000;
      const historyMessages = Array.from({ length: 42 }, (_, index) => ({
        content: [
          {
            text:
              index === 41
                ? "Deployment summary complete. The final receipt remains fully reachable above the composer."
                : `Release review ${index + 1}\n${"Verified transcript detail. ".repeat(5)}`,
            type: "text",
          },
        ],
        role: index % 2 === 0 ? "user" : "assistant",
        timestamp: baseTs + index,
        __openclaw: {
          id: index === 41 ? "floating-composer-tail" : `history-${index}`,
          seq: index + 1,
        },
      }));
      const gateway = await installMockGateway(page, { historyMessages });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await setThemeMode(page, theme);
        const textarea = page.locator(".agent-chat__composer-combobox textarea");
        const tail = page.locator('[data-entry-id="floating-composer-tail"]');
        await tail.waitFor({ state: "visible", timeout: 10_000 });
        await waitForChatScrollIdle(page);
        await scrollChatThreadToTop(page);
        const scrollToLatest = page.getByRole("button", { name: "Scroll to latest" });
        await scrollToLatest.waitFor({ state: "visible", timeout: 10_000 });

        await gateway.setOnline(false);
        await gateway.closeLatest();
        for (const message of [
          "Queue the accessibility pass after reconnect",
          "Then publish the release checklist with the final screenshots",
        ]) {
          await textarea.fill(message);
          await textarea.press("Enter");
          await page.locator(".chat-queue__item", { hasText: message }).waitFor({
            state: "visible",
            timeout: 10_000,
          });
        }

        await textarea.fill(
          [
            "Add the remaining release notes:",
            "- confirm the migration path",
            "- document the rollback signal",
            "- attach the light and dark evidence",
            "- notify the release owner",
          ].join("\n"),
        );
        await page.locator("openclaw-toast-host").evaluate((element) => {
          const host = element as HTMLElement & {
            show: (options: { durationMs: number; message: string }) => void;
          };
          host.show({
            durationMs: 60_000,
            message: "Draft restored. Review the queued release work before reconnecting.",
          });
        });
        await page.locator(".app-toast").waitFor({ state: "visible" });
        await captureProof(page, theme, "backscroll");

        const conversation = page.locator(".chat-main__conversation");
        const thread = page.locator(".chat-thread");
        const dock = page.locator(".chat-bottom-dock");
        await dock.waitFor({ state: "visible" });
        const readDockLayout = () =>
          conversation.evaluate((element) => {
            const thread = element.querySelector<HTMLElement>(".chat-thread");
            const dock = element.querySelector<HTMLElement>(".chat-bottom-dock");
            const button = element.querySelector<HTMLElement>(".chat-scroll-to-bottom");
            const toast = document.querySelector<HTMLElement>(".app-toast");
            if (!thread || !dock || !toast) {
              throw new Error("expected transcript, composer dock, and toast");
            }
            const conversationRect = element.getBoundingClientRect();
            const threadRect = thread.getBoundingClientRect();
            const dockRect = dock.getBoundingClientRect();
            const buttonRect = button?.getBoundingClientRect();
            const toastRect = toast.getBoundingClientRect();
            return {
              buttonGap: buttonRect ? dockRect.top - buttonRect.bottom : null,
              dockBottom: dockRect.bottom,
              dockHeight: dockRect.height,
              dockTop: dockRect.top,
              paddingBottom: Number.parseFloat(getComputedStyle(thread).paddingBottom),
              threadBottom: threadRect.bottom,
              toastGap: dockRect.top - toastRect.bottom,
              viewportBottom: conversationRect.bottom,
            };
          });

        const expanded = await readDockLayout();
        expect(Math.abs(expanded.threadBottom - expanded.viewportBottom)).toBeLessThanOrEqual(1);
        expect(Math.abs(expanded.dockBottom - expanded.viewportBottom)).toBeLessThanOrEqual(1);
        expect(expanded.paddingBottom).toBeGreaterThan(expanded.dockHeight);
        expect(expanded.buttonGap ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(8);
        expect(expanded.toastGap).toBeGreaterThanOrEqual(8);

        const scrollTopBeforeResize = await thread.evaluate((element) => element.scrollTop);
        await textarea.fill("Short follow-up draft");
        await expect
          .poll(async () => (await readDockLayout()).dockHeight)
          .toBeLessThan(expanded.dockHeight);
        await expect
          .poll(async () => (await readDockLayout()).paddingBottom)
          .toBeLessThan(expanded.paddingBottom);
        const compact = await readDockLayout();
        expect(compact.dockHeight).toBeLessThan(expanded.dockHeight);
        expect(await thread.evaluate((element) => element.scrollTop)).toBeCloseTo(
          scrollTopBeforeResize,
          0,
        );

        await textarea.fill(
          [
            "Add the remaining release notes:",
            "- confirm the migration path",
            "- document the rollback signal",
            "- attach the light and dark evidence",
            "- notify the release owner",
          ].join("\n"),
        );
        await expect
          .poll(async () => (await readDockLayout()).dockHeight)
          .toBeGreaterThan(compact.dockHeight);
        await expect
          .poll(async () => (await readDockLayout()).paddingBottom)
          .toBeGreaterThan(compact.paddingBottom);
        expect(await thread.evaluate((element) => element.scrollTop)).toBeCloseTo(
          scrollTopBeforeResize,
          0,
        );

        await scrollToLatest.click();
        await expect
          .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
          .toBeLessThanOrEqual(8);
        await tail.waitFor({ state: "visible" });
        const endLayout = await readDockLayout();
        const tailBox = await tail.locator(".chat-text").boundingBox();
        expect(tailBox).not.toBeNull();
        const tailBottom = tailBox ? tailBox.y + tailBox.height : endLayout.dockTop;
        expect(endLayout.dockTop - tailBottom).toBeGreaterThanOrEqual(0);
        await captureProof(page, theme, "exact-end");
      } finally {
        await context.close();
      }
    },
  );
});
