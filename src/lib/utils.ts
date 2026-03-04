import type { CheerioAPI } from "crawlee";
import type { Page } from "playwright";

import { Dataset } from "crawlee";
import crypto from "crypto";
import { sql } from "drizzle-orm";
import fs from "fs";
import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "path";

import { db } from "@/db";
import { scrapedImages } from "@/db/schema";
import { logger } from "@/lib/logger";

const utilsLogger = logger.child({ module: "utils" });

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export type RawItem = {
  url: string;
  hostname: string | null;
  domain: string | null;
  title: string;
  favicon: string;
  images: Array<{
    src: string;
    width: number;
    height: number;
    alt: string;
  }>;
};

export type BatchContext = {
  itemBatch: RawItem[];
  pendingUploads: Promise<void>[];
};

export function generateRandomString() {
  return crypto.randomBytes(16).toString("hex");
}

export function isValidImageUrl(src: string): boolean {
  if (!src || src.length < 10) return false;
  if (src.startsWith("data:")) return false;
  if (src.startsWith("blob:")) return false;
  if (!src.startsWith("http://") && !src.startsWith("https://")) return false;

  try {
    const pathname = new URL(src).pathname.toLowerCase();
    if (pathname.endsWith(".svg") || pathname.endsWith(".gif")) return false;
  } catch {
    return false;
  }

  const lowercaseSrc = src.toLowerCase();

  const skipPatterns = [
    "placeholder",
    "lazy",
    "loading",
    "spinner",
    "1x1",
    "pixel",
    "transparent",
    "empty",
    "spacer",
    "blank",
  ];

  return !skipPatterns.some((pattern) => lowercaseSrc.includes(pattern));
}

export function validateAndNormalizeUrl(url: string): string | null {
  try {
    url = url.trim();

    if (
      !url ||
      url.startsWith("#") ||
      url.startsWith("javascript:") ||
      url.startsWith("mailto:") ||
      url.startsWith("tel:") ||
      url.startsWith("void(0)") ||
      url === "javascript:void(0);" ||
      url.length < 8
    ) {
      return null;
    }

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }

    const urlObj = new URL(url);

    if (!urlObj.hostname || urlObj.hostname.length === 0) {
      return null;
    }

    if (urlObj.hostname.startsWith("www.")) {
      urlObj.hostname = urlObj.hostname.slice(4);
    }

    urlObj.hash = "";

    const normalized = urlObj.toString().replace(/\/$/, "");

    return normalized;
  } catch (error) {
    utilsLogger.warn({ url, err: toError(error) }, "Invalid URL skipped");
    return null;
  }
}

export async function shouldSkipPage(page: Page): Promise<boolean> {
  try {
    const response = page.mainFrame().url();

    if (!response) return true;

    const [title, bodyText, hasHtml] = await Promise.all([
      page.title(),
      page
        .locator("body")
        .innerText()
        .catch(() => ""),
      page.locator("html").count(),
    ]);

    if (!hasHtml) return true;

    const lowerTitle = title.toLowerCase();
    if (
      lowerTitle.includes("404") ||
      lowerTitle.includes("403") ||
      lowerTitle.includes("error") ||
      lowerTitle.includes("not found") ||
      lowerTitle.includes("access denied")
    )
      return true;

    if (bodyText.trim().length < 100) return true;

    return false;
  } catch {
    return true;
  }
}

export async function scrollToBottom(page: Page, maxScrolls: number = 10): Promise<void> {
  for (let i = 0; i < maxScrolls; i++) {
    const previousHeight = await page.evaluate(() => document.documentElement.scrollHeight);

    await page.mouse.wheel(0, 800);

    await page.waitForTimeout(500);

    const newHeight = await page.evaluate(() => document.documentElement.scrollHeight);

    if (newHeight <= previousHeight) break;
  }

  await page.evaluate(() => window.scrollTo(0, 0));
}

export function needsJsRendering($: CheerioAPI): boolean {
  const hasReactRoot = $("div#root, div#app, div#__next, div#__nuxt").length > 0;

  const hasNoscriptContent = $("noscript").text().trim().length > 50;

  if (hasReactRoot || hasNoscriptContent) return true;

  const hasFrameworkAttrs =
    $("[ng-app], [ng-controller], [v-app], [data-server-rendered]").length > 0;

  if (hasFrameworkAttrs) return true;

  const hasImages = $("img[src]").length > 0;

  const hasStaticContent = $("p, article, main, section").length > 0;

  const bodyText = $("body").text().trim();

  const isEffectivelyEmpty = bodyText.length < 100 && !hasStaticContent;

  if (hasImages && isEffectivelyEmpty) return true;

  return isEffectivelyEmpty;
}

export function loadNormalizedUrlSet(fileName: string): Set<string> {
  const filePath = path.join(process.cwd(), fileName);

  if (!fs.existsSync(filePath)) {
    return new Set();
  }

  return new Set(
    readFileSync(filePath, "utf8")
      .split("\n")
      .map((url) => validateAndNormalizeUrl(url.trim()))
      .filter((url): url is string => url !== null),
  );
}

export function loadSeedUrls(
  seedFileName: string,
  failedUrls: Set<string>,
  cachedUrls: Set<string>,
): string[] {
  return readFileSync(path.join(process.cwd(), seedFileName), "utf8")
    .split("\n")
    .map(validateAndNormalizeUrl)
    .filter((url): url is string => url !== null)
    .filter((url) => !failedUrls.has(url) && !cachedUrls.has(url));
}

export async function addToFailedUrls(
  failedUrls: Set<string>,
  url: string,
  reason: string,
): Promise<void> {
  const normalizedUrl = validateAndNormalizeUrl(url.trim());

  if (normalizedUrl && !failedUrls.has(normalizedUrl)) {
    failedUrls.add(normalizedUrl);
    await appendFile("failed_urls.txt", normalizedUrl + "\n");
    utilsLogger.info({ reason, url }, "Added URL to failed_urls.txt");
  }
}

export async function addToCache(
  cachedUrls: Set<string>,
  urls: string | string[],
  reason: string,
): Promise<void> {
  const urlArray = Array.isArray(urls) ? urls : [urls];
  const newUrls = urlArray.filter((url) => {
    const normalized = validateAndNormalizeUrl(url.trim());
    return normalized && !cachedUrls.has(normalized);
  });

  if (newUrls.length > 0) {
    await appendFile("cache.txt", newUrls.join("\n") + "\n");
    newUrls.forEach((url) => {
      const normalized = validateAndNormalizeUrl(url.trim());
      if (normalized) cachedUrls.add(normalized);
    });
    utilsLogger.info({ reason, addedCount: newUrls.length }, "Added URLs to cache.txt");
  }
}

export async function cleanupStorage(): Promise<void> {
  const storagePath = path.join(process.cwd(), "storage");
  try {
    if (fs.existsSync(storagePath)) {
      fs.rmSync(storagePath, { recursive: true, force: true });
    }
  } catch (error) {
    utilsLogger.warn({ err: toError(error) }, "Failed to clean up storage");
  }
}

export async function uploadBatch(
  items: RawItem[],
  addToCacheFn: (urls: string | string[], reason: string) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;

  try {
    const uniqueItems = Array.from(new Map(items.map((item) => [item.url, item])).values());

    const rows = uniqueItems.map((item) => ({
      url: item.url,
      hostname: item.hostname ?? "",
      domain: item.domain ?? "",
      title: item.title,
      favicon: item.favicon,
      images: item.images,
    }));

    await db
      .insert(scrapedImages)
      .values(rows)
      .onConflictDoUpdate({
        target: scrapedImages.url,
        set: {
          hostname: sql`excluded.hostname`,
          domain: sql`excluded.domain`,
          title: sql`excluded.title`,
          favicon: sql`excluded.favicon`,
          images: sql`excluded.images`,
          updatedAt: sql`now()`,
        },
      });

    await Dataset.pushData(uniqueItems);

    const urlsToCache = uniqueItems
      .map((item) => validateAndNormalizeUrl(item.url))
      .filter((url): url is string => url !== null);

    await addToCacheFn(urlsToCache, "Successful database upload");

    utilsLogger.info({ uploadedCount: uniqueItems.length }, "Uploaded items to database");
  } catch (error) {
    utilsLogger.error({ err: toError(error) }, "Failed to upload batch");
  }
}

export function dispatchBatch(
  context: BatchContext,
  items: RawItem[],
  uploadBatchFn: (items: RawItem[]) => Promise<void>,
): void {
  if (items.length === 0) return;

  const upload = uploadBatchFn(items);
  context.pendingUploads.push(upload);
  upload.finally(() => {
    const idx = context.pendingUploads.indexOf(upload);
    if (idx !== -1) context.pendingUploads.splice(idx, 1);
  });
}

export function processBatch(
  context: BatchContext,
  batchSize: number,
  uploadBatchFn: (items: RawItem[]) => Promise<void>,
): void {
  if (context.itemBatch.length >= batchSize) {
    dispatchBatch(context, context.itemBatch.splice(0, batchSize), uploadBatchFn);
  }
}

export async function flushPendingUploads(
  context: BatchContext,
  uploadBatchFn: (items: RawItem[]) => Promise<void>,
): Promise<void> {
  if (context.itemBatch.length > 0) {
    utilsLogger.info({ remainingCount: context.itemBatch.length }, "Flushing remaining items");
    dispatchBatch(context, context.itemBatch.splice(0, context.itemBatch.length), uploadBatchFn);
  }

  if (context.pendingUploads.length === 0) return;

  utilsLogger.info(
    { inFlightCount: context.pendingUploads.length },
    "Waiting for in-flight uploads",
  );

  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 30_000));

  const result = await Promise.race([
    Promise.allSettled(context.pendingUploads).then(() => "done" as const),
    timeout,
  ]);

  if (result === "timeout") {
    utilsLogger.error(
      { pendingCount: context.pendingUploads.length },
      "Flush timed out; uploads may be incomplete",
    );
  } else {
    utilsLogger.info("All uploads completed successfully");
  }
}
