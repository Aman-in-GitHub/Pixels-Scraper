import {
  CheerioCrawler,
  Dataset,
  log,
  PlaywrightCrawler,
  RequestQueue,
  type CheerioAPI,
} from "crawlee";
import fs from "fs";
import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "path";
import { parse } from "tldts";

import { BATCH_SIZE, PAGE_TYPES_TO_EXCLUDE, TRUSTED_WEBSITES_TO_EXCLUDE } from "./constants.js";
import { supabase } from "./supabase.js";
import {
  isValidImageUrl,
  scrollToBottom,
  shouldSkipPage,
  validateAndNormalizeUrl,
} from "./utils.js";

type RawItem = {
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

let itemBatch: RawItem[] = [];

const pendingUploads: Promise<void>[] = [];

const failedUrls = new Set(
  fs.existsSync(path.join(process.cwd(), "failed_urls.txt"))
    ? readFileSync(path.join(process.cwd(), "failed_urls.txt"), "utf8")
        .split("\n")
        .map((url) => validateAndNormalizeUrl(url.trim()))
        .filter((url): url is string => url !== null)
    : [],
);

const cachedUrls = new Set(
  fs.existsSync(path.join(process.cwd(), "cache.txt"))
    ? readFileSync(path.join(process.cwd(), "cache.txt"), "utf8")
        .split("\n")
        .map((url) => validateAndNormalizeUrl(url.trim()))
        .filter((url): url is string => url !== null)
    : [],
);

const seedUrls = readFileSync(path.join(process.cwd(), "seed.txt"), "utf8")
  .split("\n")
  .map(validateAndNormalizeUrl)
  .filter((url): url is string => url !== null)
  .filter((url) => !failedUrls.has(url) && !cachedUrls.has(url));

const EXCLUDE_PATTERNS = [
  new RegExp(`\\.(${PAGE_TYPES_TO_EXCLUDE.join("|")})$`, "i"),
  new RegExp(`(${TRUSTED_WEBSITES_TO_EXCLUDE.join("|").replace(/\./g, "\\.")})`, "i"),
  /^javascript:/i,
  /^mailto:/i,
  /^tel:/i,
  /^#/,
  /^void\(0\)/i,
];

async function uploadBatch(items: RawItem[]): Promise<void> {
  if (items.length === 0) return;

  try {
    const uniqueItems = Array.from(new Map(items.map((item) => [item.url, item])).values());

    const { error } = await supabase.from("scraped_images").upsert(uniqueItems, {
      onConflict: "url",
    });

    if (error) {
      log.error(`Error inserting ${uniqueItems.length} items: ${error.message}`);
      return;
    }

    await Dataset.pushData(uniqueItems);

    const urlsToCache = uniqueItems
      .map((item) => validateAndNormalizeUrl(item.url))
      .filter((url): url is string => url !== null);

    await addToCache(urlsToCache, "Successful database upload");

    log.info(`SUCCESS: Uploaded ${uniqueItems.length} items to database`);
  } catch (error) {
    log.error(`Failed to upload batch: ${error}`);
  }
}

function dispatchBatch(items: RawItem[]): void {
  if (items.length === 0) return;
  const upload = uploadBatch(items);
  pendingUploads.push(upload);
  upload.finally(() => {
    const idx = pendingUploads.indexOf(upload);
    if (idx !== -1) pendingUploads.splice(idx, 1);
  });
}

function processBatch(): void {
  if (itemBatch.length >= BATCH_SIZE) {
    dispatchBatch(itemBatch.splice(0, BATCH_SIZE));
  }
}

async function flushPendingUploads(): Promise<void> {
  if (itemBatch.length > 0) {
    log.info(`Flushing remaining ${itemBatch.length} items...`);
    dispatchBatch(itemBatch);
    itemBatch = [];
  }

  if (pendingUploads.length === 0) return;

  log.info(`Waiting for ${pendingUploads.length} in-flight uploads...`);

  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 30_000));

  const result = await Promise.race([
    Promise.allSettled(pendingUploads).then(() => "done" as const),
    timeout,
  ]);

  if (result === "timeout") {
    log.error(`Flush timed out — ${pendingUploads.length} uploads may be incomplete`);
  } else {
    log.info("All uploads completed successfully");
  }
}

async function addToFailedUrls(url: string, reason: string): Promise<void> {
  const normalizedUrl = validateAndNormalizeUrl(url.trim());

  if (normalizedUrl && !failedUrls.has(normalizedUrl)) {
    failedUrls.add(normalizedUrl);
    await appendFile("failed_urls.txt", normalizedUrl + "\n");
    log.info(`${reason} | ${url} added to failed_urls.txt`);
  }
}

async function addToCache(urls: string | string[], reason: string): Promise<void> {
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
    log.info(`${reason} | Added ${newUrls.length} new URLs to cache.txt`);
  }
}

async function cleanupStorage(): Promise<void> {
  const storagePath = path.join(process.cwd(), "storage");
  try {
    if (fs.existsSync(storagePath)) {
      fs.rmSync(storagePath, { recursive: true, force: true });
    }
  } catch (error) {
    log.warning(`Failed to cleanup storage: ${error}`);
  }
}

function needsJsRendering($: CheerioAPI): boolean {
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

async function startCrawler(): Promise<void> {
  await cleanupStorage();

  log.info(`Loaded ${cachedUrls.size} cached URLs and ${failedUrls.size} failed URLs`);

  log.info(`Starting with ${seedUrls.length} seed URLs after filtering`);

  const cheerioQueue = await RequestQueue.open(`CHEERIO-QUEUE-${Date.now()}`);

  const playwrightQueue = await RequestQueue.open(`PLAYWRIGHT-QUEUE-${Date.now()}`);

  const cheerioCrawler = new CheerioCrawler({
    requestQueue: cheerioQueue,
    maxConcurrency: 20,
    maxRequestRetries: 1,
    requestHandlerTimeoutSecs: 30,

    failedRequestHandler: async ({ request }) => {
      await addToFailedUrls(request.url, "Cheerio: too many retries");
    },

    async requestHandler({ request, $, enqueueLinks }) {
      const normalizedLoadedUrl = validateAndNormalizeUrl(request.loadedUrl);

      if (normalizedLoadedUrl && cachedUrls.has(normalizedLoadedUrl)) {
        log.info(`SKIPPING (cached): ${request.loadedUrl}`);
        return;
      }

      if (needsJsRendering($)) {
        log.info(`ESCALATING to Playwright: ${request.loadedUrl}`);
        await playwrightQueue.addRequest({ url: request.loadedUrl });
        return;
      }

      await enqueueLinks({
        requestQueue: cheerioQueue,
        strategy: "all",
        exclude: EXCLUDE_PATTERNS,
        transformRequestFunction: (req) => {
          const normalized = validateAndNormalizeUrl(req.url);
          if (!normalized || cachedUrls.has(normalized) || failedUrls.has(normalized)) return false;
          return req;
        },
      });

      const parsedUrl = parse(request.loadedUrl);
      const title = $("title").text().trim() || "N/A";
      const favicon =
        $('link[rel*="icon"]').attr("href") || new URL("/favicon.ico", request.loadedUrl).href;

      const imageUrls = $("img")
        .toArray()
        .map((el) => ({
          src: (() => {
            try {
              return new URL($(el).attr("src") || "", request.loadedUrl).href;
            } catch {
              return "";
            }
          })(),
          width: parseInt($(el).attr("width") || "0", 10),
          height: parseInt($(el).attr("height") || "0", 10),
          alt: $(el).attr("alt") || "N/A",
        }))
        .filter((img) => img.src !== "" && isValidImageUrl(img.src));

      if (imageUrls.length === 0) {
        await addToFailedUrls(request.loadedUrl, "Cheerio: no images found");
        return;
      }

      itemBatch.push({
        url: request.loadedUrl,
        hostname: parsedUrl.hostname,
        domain: parsedUrl.domain,
        title,
        favicon,
        images: imageUrls,
      });

      log.info(
        `[CHEERIO] ${title} | ${parsedUrl.hostname} | ${imageUrls.length} image(s) | Batch: ${itemBatch.length}/${BATCH_SIZE}`,
      );

      processBatch();
    },
  });

  const playwrightCrawler = new PlaywrightCrawler({
    requestQueue: playwrightQueue,
    headless: true,
    minConcurrency: 10,
    maxConcurrency: 20,
    maxRequestRetries: 1,
    requestHandlerTimeoutSecs: 30,

    failedRequestHandler: async ({ request }) => {
      await addToFailedUrls(request.url, "Playwright: too many retries");
    },

    async requestHandler({ request, page, enqueueLinks }) {
      const normalizedLoadedUrl = validateAndNormalizeUrl(request.loadedUrl);

      if (normalizedLoadedUrl && cachedUrls.has(normalizedLoadedUrl)) {
        log.info(`SKIPPING (cached): ${request.loadedUrl}`);
        return;
      }

      await page.waitForLoadState("domcontentloaded");

      const isInvalidPage = await shouldSkipPage(page);

      if (isInvalidPage) {
        await addToFailedUrls(request.loadedUrl, "Invalid page");
        return;
      }

      await scrollToBottom(page);

      await enqueueLinks({
        requestQueue: cheerioQueue,
        strategy: "all",
        exclude: EXCLUDE_PATTERNS,
        transformRequestFunction: (req) => {
          const normalized = validateAndNormalizeUrl(req.url);
          if (!normalized || cachedUrls.has(normalized) || failedUrls.has(normalized)) return false;
          return req;
        },
      });

      const parsedUrl = parse(request.loadedUrl);
      const title = await page.title();
      const favicon = await page
        .$eval('link[rel*="icon"]', (link) => (link as HTMLLinkElement).href)
        .catch(() => null);

      const imageUrls = (
        await page.$$eval("img", (imgs) =>
          imgs
            .filter((img) => img.naturalWidth > 100 && img.naturalHeight > 100)
            .map((img) => ({
              src: img.src,
              width: img.naturalWidth,
              height: img.naturalHeight,
              alt: img.alt || "N/A",
            })),
        )
      ).filter((img) => isValidImageUrl(img.src));

      if (imageUrls.length === 0) {
        await addToFailedUrls(request.loadedUrl, "Playwright: no images found");
        return;
      }

      itemBatch.push({
        url: request.loadedUrl,
        hostname: parsedUrl.hostname,
        domain: parsedUrl.domain,
        title,
        favicon: favicon || new URL("/favicon.ico", page.url()).href,
        images: imageUrls,
      });

      log.info(
        `[PLAYWRIGHT] ${title} | ${parsedUrl.hostname} | ${imageUrls.length} image(s) | Batch: ${itemBatch.length}/${BATCH_SIZE}`,
      );

      processBatch();
    },
  });

  await Promise.all([cheerioCrawler.run(seedUrls), playwrightCrawler.run([])]);

  await flushPendingUploads();

  await Dataset.exportToCSV(Date.now().toString());

  await cleanupStorage();

  log.info("SUCCESS: Scraping completed successfully");
}

startCrawler();
