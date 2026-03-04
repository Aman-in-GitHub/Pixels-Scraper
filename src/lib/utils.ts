import type { CheerioAPI, RequestQueue } from "crawlee";
import type { Page } from "playwright";

import { Dataset } from "crawlee";
import crypto from "crypto";
import { sql } from "drizzle-orm";
import fs from "fs";
import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "path";
import { createInterface } from "readline";

import { db } from "@/db";
import { scrapedImages } from "@/db/schema";
import { logger } from "@/lib/logger";

const utilsLogger = logger.child({ module: "utils" });

const MAX_FLUSH_PASSES = 5;
const FLUSH_TIMEOUT_MS = 30_000;
const DEFAULT_SEED_ENQUEUE_BATCH_SIZE = 1_000;

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
    const responseUrl = page.mainFrame().url();

    if (!responseUrl) return true;

    const [title, signals] = await Promise.all([
      page.title().catch(() => ""),
      page
        .evaluate(() => {
          const body = document.body;
          const hasHtml = Boolean(document.documentElement);
          if (!hasHtml || !body) return { hasHtml: false, textLength: 0 };
          return {
            hasHtml: true,
            textLength: (body.textContent || "").trim().length,
          };
        })
        .catch(() => ({ hasHtml: false, textLength: 0 })),
    ]);

    if (!signals.hasHtml) return true;

    const lowerTitle = title.toLowerCase();
    if (
      lowerTitle.includes("404") ||
      lowerTitle.includes("403") ||
      lowerTitle.includes("error") ||
      lowerTitle.includes("not found") ||
      lowerTitle.includes("access denied")
    )
      return true;

    if (signals.textLength < 100) return true;

    return false;
  } catch {
    return true;
  }
}

export async function scrollToBottom(
  page: Page,
  maxScrolls: number = 8,
  waitAfterScrollMs: number = 200,
): Promise<void> {
  const MAX_SCROLL_TIME_MS = 1_200;

  const STAGNANT_ROUNDS_BEFORE_STOP = 2;

  const MIN_IMAGE_GOAL_BEFORE_SCROLL = 12;

  const getScrollSignals = async (): Promise<{
    scrollHeight: number;
    uniqueImageCandidateCount: number;
    hasLazySignals: boolean;
  }> =>
    page.evaluate(() => {
      const toAbsoluteHttpUrl = (value: string | null): string | null => {
        if (!value) return null;
        const trimmed = value.trim();
        if (!trimmed) return null;

        try {
          const absoluteUrl = new URL(trimmed, window.location.href).href;
          if (!absoluteUrl.startsWith("http://") && !absoluteUrl.startsWith("https://")) {
            return null;
          }
          return absoluteUrl;
        } catch {
          return null;
        }
      };

      const addSrcsetEntries = (target: Set<string>, srcset: string | null): void => {
        if (!srcset) return;
        for (const candidate of srcset.split(",")) {
          const urlPart = candidate.trim().split(/\s+/)[0] ?? "";
          const absoluteUrl = toAbsoluteHttpUrl(urlPart);
          if (absoluteUrl) target.add(absoluteUrl);
        }
      };

      const imageCandidates = new Set<string>();
      const imgNodes = Array.from(document.querySelectorAll("img"));

      for (const img of imgNodes) {
        const currentSrcUrl = toAbsoluteHttpUrl(img.currentSrc || null);
        if (currentSrcUrl) imageCandidates.add(currentSrcUrl);

        const attributeKeys = [
          "src",
          "data-src",
          "data-original",
          "data-lazy-src",
          "data-srcset",
          "srcset",
        ] as const;

        for (const key of attributeKeys) {
          const value = img.getAttribute(key);
          if (!value) continue;

          if (key.includes("srcset")) {
            addSrcsetEntries(imageCandidates, value);
            continue;
          }

          const absoluteUrl = toAbsoluteHttpUrl(value);
          if (absoluteUrl) imageCandidates.add(absoluteUrl);
        }
      }

      const sourceNodes = Array.from(
        document.querySelectorAll("source[srcset], source[data-srcset]"),
      );
      for (const source of sourceNodes) {
        addSrcsetEntries(imageCandidates, source.getAttribute("srcset"));
        addSrcsetEntries(imageCandidates, source.getAttribute("data-srcset"));
      }

      const hasLazySignals =
        document.querySelector(
          'img[loading="lazy"], img[data-src], img[data-srcset], img[data-lazy-src], img[data-original], [class*="lazy"], [data-infinite-scroll]',
        ) !== null;

      return {
        scrollHeight: document.documentElement?.scrollHeight ?? 0,
        uniqueImageCandidateCount: imageCandidates.size,
        hasLazySignals,
      };
    });

  const scrollStartMs = Date.now();

  const scrollStepPixels = Math.max(page.viewportSize()?.height ?? 1200, 1200);

  let {
    scrollHeight: previousHeight,
    uniqueImageCandidateCount,
    hasLazySignals,
  } = await getScrollSignals();

  if (uniqueImageCandidateCount >= MIN_IMAGE_GOAL_BEFORE_SCROLL && !hasLazySignals) {
    return;
  }

  let stagnantRounds = 0;

  for (let i = 0; i < maxScrolls; i++) {
    if (Date.now() - scrollStartMs >= MAX_SCROLL_TIME_MS) break;

    await page.mouse.wheel(0, scrollStepPixels);

    await page.waitForTimeout(waitAfterScrollMs);

    const signals = await getScrollSignals();
    const hasHeightGrowth = signals.scrollHeight > previousHeight;
    const hasImageGrowth = signals.uniqueImageCandidateCount > uniqueImageCandidateCount;

    if (!hasHeightGrowth && !hasImageGrowth) {
      stagnantRounds += 1;
    } else {
      stagnantRounds = 0;
    }

    previousHeight = Math.max(previousHeight, signals.scrollHeight);
    uniqueImageCandidateCount = Math.max(
      uniqueImageCandidateCount,
      signals.uniqueImageCandidateCount,
    );
    hasLazySignals = signals.hasLazySignals;

    if (stagnantRounds >= STAGNANT_ROUNDS_BEFORE_STOP) break;

    if (uniqueImageCandidateCount >= MIN_IMAGE_GOAL_BEFORE_SCROLL && !hasLazySignals) {
      break;
    }
  }
}

export function needsJsRendering($: CheerioAPI): boolean {
  const normalizedBodyText = $("body").text().replace(/\s+/g, " ").trim();
  const bodyTextLength = normalizedBodyText.length;

  const staticBlockCount = $("p, article, main, section, li").length;
  const hasStaticContent = staticBlockCount > 0;

  const frameworkRootCount = $(
    "div#root, div#app, div#__next, div#__nuxt, [data-reactroot]",
  ).length;
  const hasFrameworkRoots = frameworkRootCount > 0;

  const hasFrameworkAttrs =
    $("[ng-app], [ng-controller], [ng-version], [v-app], [data-server-rendered]").length > 0;

  const hasHydrationData =
    $('script#__NEXT_DATA__, script#__NUXT_DATA__, script[data-rh="true"]').length > 0;

  const scriptCount = $("script").length;
  const hasChunkLikeScripts =
    $('script[src*="_next/"], script[src*="chunk"], script[src*="webpack"]').length > 0;

  const noscriptTextLength = $("noscript").text().replace(/\s+/g, " ").trim().length;
  const hasLargeNoscriptContent = noscriptTextLength > 120;

  const imageNodes = $("img[src]").toArray();
  const usableImageHintCount = imageNodes.filter((el) => {
    const src = ($(el).attr("src") ?? "").trim().toLowerCase();
    if (!src) return false;
    if (src.startsWith("data:") || src.startsWith("blob:")) return false;
    return true;
  }).length;

  const lazyImageSignalsCount = $(
    'img[loading="lazy"], img[data-src], img[data-srcset], img[data-lazy-src], img[data-original], source[data-srcset], [class*="lazy"]',
  ).length;
  const hasLazyImageSignals = lazyImageSignalsCount > 0;

  const isEffectivelyEmpty = bodyTextLength < 100 && !hasStaticContent;
  if (isEffectivelyEmpty) return true;

  const hasStrongJsSignals =
    hasHydrationData ||
    (hasFrameworkRoots && (hasLazyImageSignals || bodyTextLength < 220)) ||
    (hasChunkLikeScripts && bodyTextLength < 200);

  if (hasStrongJsSignals && usableImageHintCount < 8) return true;

  const hasStrongStaticSignals =
    usableImageHintCount >= 10 &&
    bodyTextLength >= 220 &&
    staticBlockCount >= 3 &&
    !hasLazyImageSignals;

  if (hasStrongStaticSignals) return false;

  let jsScore = 0;

  if (hasHydrationData) jsScore += 4;
  if (hasFrameworkRoots) jsScore += 3;
  if (hasFrameworkAttrs) jsScore += 2;
  if (hasChunkLikeScripts) jsScore += 1;
  if (hasLargeNoscriptContent) jsScore += 1;
  if (hasLazyImageSignals) jsScore += 2;
  if (scriptCount >= 10) jsScore += 1;
  if (scriptCount >= 18) jsScore += 1;
  if (bodyTextLength < 150) jsScore += 2;
  else if (bodyTextLength < 260) jsScore += 1;
  if (!hasStaticContent) jsScore += 1;
  if (usableImageHintCount === 0) jsScore += 1;

  if (usableImageHintCount >= 6 && bodyTextLength >= 220) jsScore -= 3;
  if (staticBlockCount >= 4 && bodyTextLength >= 300) jsScore -= 2;
  if (scriptCount <= 2 && bodyTextLength >= 400) jsScore -= 1;

  return jsScore >= 5;
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

export async function enqueueSeedUrls(
  seedFileName: string,
  failedUrls: Set<string>,
  cachedUrls: Set<string>,
  requestQueue: RequestQueue,
  batchSize: number = DEFAULT_SEED_ENQUEUE_BATCH_SIZE,
): Promise<{ scannedCount: number; enqueuedCount: number }> {
  const filePath = path.join(process.cwd(), seedFileName);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Seed file not found: ${filePath}`);
  }

  let scannedCount = 0;
  let enqueuedCount = 0;
  const requestBatch: Array<{ url: string; uniqueKey: string }> = [];

  const flushBatch = async (): Promise<void> => {
    if (requestBatch.length === 0) return;

    const { processedRequests } = await requestQueue.addRequests(requestBatch);
    enqueuedCount += processedRequests.filter(
      (req) => !req.wasAlreadyHandled && !req.wasAlreadyPresent,
    ).length;
    requestBatch.length = 0;
  };

  const lineReader = createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lineReader) {
    scannedCount += 1;
    const normalized = validateAndNormalizeUrl(line);

    if (!normalized || failedUrls.has(normalized) || cachedUrls.has(normalized)) {
      continue;
    }

    requestBatch.push({ url: normalized, uniqueKey: normalized });

    if (requestBatch.length >= batchSize) {
      await flushBatch();
    }
  }

  await flushBatch();

  return { scannedCount, enqueuedCount };
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
  const seenInBatch = new Set<string>();
  const normalizedUrlsToAdd: string[] = [];

  for (const rawUrl of urlArray) {
    const normalized = validateAndNormalizeUrl(rawUrl.trim());
    if (!normalized) continue;
    if (cachedUrls.has(normalized) || seenInBatch.has(normalized)) continue;

    seenInBatch.add(normalized);
    normalizedUrlsToAdd.push(normalized);
  }

  if (normalizedUrlsToAdd.length === 0) return;

  await appendFile("cached_urls.txt", normalizedUrlsToAdd.join("\n") + "\n");

  for (const normalizedUrl of normalizedUrlsToAdd) {
    cachedUrls.add(normalizedUrl);
  }

  utilsLogger.info(
    { reason, addedCount: normalizedUrlsToAdd.length },
    "Added URLs to cache_urls.txt",
  );
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

  utilsLogger.info({ uploadedCount: uniqueItems.length }, "Uploaded scraped images to database");
}

export function dispatchBatch(
  context: BatchContext,
  items: RawItem[],
  uploadBatchFn: (items: RawItem[]) => Promise<void>,
): void {
  if (items.length === 0) return;

  const upload = uploadBatchFn(items).catch((error) => {
    context.itemBatch.unshift(...items);
    utilsLogger.error(
      { err: toError(error), itemCount: items.length },
      "Batch upload failed; re-queued for retry",
    );
  });
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
  for (let pass = 1; pass <= MAX_FLUSH_PASSES; pass += 1) {
    if (context.itemBatch.length > 0) {
      utilsLogger.info(
        { pass, remainingCount: context.itemBatch.length },
        "Flushing remaining items",
      );
      dispatchBatch(context, context.itemBatch.splice(0, context.itemBatch.length), uploadBatchFn);
    }

    if (context.pendingUploads.length > 0) {
      utilsLogger.info(
        { pass, inFlightCount: context.pendingUploads.length },
        "Waiting for in-flight uploads",
      );

      const pendingSnapshot = [...context.pendingUploads];

      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), FLUSH_TIMEOUT_MS),
      );

      const result = await Promise.race([
        Promise.allSettled(pendingSnapshot).then(() => "done" as const),
        timeout,
      ]);

      if (result === "timeout") {
        utilsLogger.error(
          { pass, pendingCount: context.pendingUploads.length },
          "Flush timed out; uploads may be incomplete",
        );
        break;
      }
    }

    if (context.itemBatch.length === 0 && context.pendingUploads.length === 0) {
      utilsLogger.info("All uploads completed successfully");
      return;
    }

    utilsLogger.warn(
      {
        pass,
        remainingCount: context.itemBatch.length,
        inFlightCount: context.pendingUploads.length,
      },
      "Uploads still pending after flush pass; retrying",
    );
  }

  if (context.itemBatch.length > 0 || context.pendingUploads.length > 0) {
    utilsLogger.error(
      {
        remainingCount: context.itemBatch.length,
        inFlightCount: context.pendingUploads.length,
      },
      "Flush finished with pending uploads",
    );
  }
}
