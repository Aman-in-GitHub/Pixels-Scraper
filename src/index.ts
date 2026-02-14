import "dotenv/config";
import { Dataset, log, PlaywrightCrawler, RequestQueue } from "crawlee";
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
  uploadScreenshotToStorage,
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
  screenshot: string;
};

type RawItemWithBuffer = Omit<RawItem, "screenshot"> & {
  screenshot_buffer: Buffer;
};

let itemBatch: RawItemWithBuffer[] = [];

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

async function uploadBatch(items: RawItemWithBuffer[]): Promise<void> {
  if (items.length === 0) return;

  try {
    const urlsToCache: string[] = [];
    const processedItemsMap = new Map<string, RawItem>();

    for (const item of items) {
      const screenshotUrl = await uploadScreenshotToStorage(item.screenshot_buffer, item.url);

      const processedItem: RawItem = {
        url: item.url,
        hostname: item.hostname,
        domain: item.domain,
        title: item.title,
        favicon: item.favicon,
        images: item.images,
        screenshot: screenshotUrl || "",
      };

      const normalizedUrl = validateAndNormalizeUrl(item.url);

      if (normalizedUrl) {
        urlsToCache.push(normalizedUrl);
      }

      processedItemsMap.set(item.url, processedItem);
    }

    const uniqueItems = Array.from(processedItemsMap.values());

    const { error } = await supabase.from("scraped_images").upsert(uniqueItems, {
      onConflict: "url",
    });

    if (error) {
      log.error(`Error inserting ${uniqueItems.length} items to database: ${error.message}`);
      return;
    }

    await Dataset.pushData(uniqueItems);

    if (urlsToCache.length > 0) {
      await addToCache(urlsToCache, "Successful database upload");
    }

    log.info(`SUCCESS: Uploaded ${uniqueItems.length} items to database`);
  } catch (error) {
    log.error(`Failed to upload batch: ${error}`);
  }
}

async function processBatch(): Promise<void> {
  if (itemBatch.length >= BATCH_SIZE) {
    const batchToUpload = itemBatch.splice(0, BATCH_SIZE);

    await uploadBatch(batchToUpload);
  }
}

async function uploadRemainingItems(): Promise<void> {
  if (itemBatch.length > 0) {
    log.info(`Uploading remaining ${itemBatch.length} items...`);

    await uploadBatch(itemBatch);

    itemBatch = [];
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
    const normalizedUrl = validateAndNormalizeUrl(url.trim());

    return normalizedUrl && !cachedUrls.has(normalizedUrl);
  });

  if (newUrls.length > 0) {
    await appendFile("cache.txt", newUrls.join("\n") + "\n");
    newUrls.forEach((url) => {
      const normalizedUrl = validateAndNormalizeUrl(url.trim());

      if (normalizedUrl) {
        cachedUrls.add(normalizedUrl);
      }
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

async function startCrawler(): Promise<void> {
  await cleanupStorage();

  log.info(`Loaded ${cachedUrls.size} cached URLs and ${failedUrls.size} failed URLs`);

  log.info(`Starting with ${seedUrls.length} seed URLs after filtering`);

  const requestQueue = await RequestQueue.open(`QUEUE-${Date.now()}`);

  const crawler = new PlaywrightCrawler({
    requestQueue,
    headless: true,
    minConcurrency: 15,
    maxConcurrency: 20,
    maxRequestRetries: 1,
    requestHandlerTimeoutSecs: 30,
    failedRequestHandler: async ({ request }) => {
      await addToFailedUrls(request.url, "Too many retries");
    },
    async requestHandler({ request, page, enqueueLinks }) {
      const normalizedLoadedUrl = validateAndNormalizeUrl(request.loadedUrl);

      if (normalizedLoadedUrl && cachedUrls.has(normalizedLoadedUrl)) {
        log.info(`SKIPPING: Already cached ${request.loadedUrl}`);
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
        strategy: "all",
        exclude: [
          // Exclude file extensions
          new RegExp(`\\.(${PAGE_TYPES_TO_EXCLUDE.join("|")})$`, "i"),
          // Exclude trusted websites (matches domain anywhere in URL)
          new RegExp(`(${TRUSTED_WEBSITES_TO_EXCLUDE.join("|").replace(/\./g, "\\.")})`, "i"),
          // Exclude "void(0)" placeholders
          /^javascript:/i,
          /^mailto:/i,
          /^tel:/i,
          /^#/,
          /^void\(0\)/i,
        ],
        transformRequestFunction: (request) => {
          const normalizedUrl = validateAndNormalizeUrl(request.url);

          if (!normalizedUrl || cachedUrls.has(normalizedUrl) || failedUrls.has(normalizedUrl)) {
            return false;
          }

          return request;
        },
      });

      const parsedUrl = parse(request.loadedUrl);

      const title = await page.title();

      const favicon = await page
        .$eval('link[rel*="icon"]', (link) => (link as HTMLLinkElement).href)
        .catch(() => null);

      const faviconUrl = favicon || new URL("/favicon.ico", page.url()).href;

      const rawImageUrls = await page.$$eval("img", (imgs) => {
        return imgs
          .filter((img) => img.naturalWidth > 200 && img.naturalHeight > 200)
          .map((img) => ({
            src: img.src,
            width: img.naturalWidth,
            height: img.naturalHeight,
            alt: img.alt || "N/A",
          }));
      });

      const imageUrls = rawImageUrls.filter((img) => isValidImageUrl(img.src));

      if (imageUrls.length === 0) {
        await addToFailedUrls(request.loadedUrl, `No images found`);
        return;
      }

      const screenshotBuffer = await page.screenshot({
        type: "png",
        fullPage: true,
      });

      const rawItem: RawItemWithBuffer = {
        url: request.loadedUrl,
        hostname: parsedUrl.hostname,
        domain: parsedUrl.domain,
        title: title,
        favicon: faviconUrl,
        images: imageUrls,
        screenshot_buffer: screenshotBuffer,
      };

      itemBatch.push(rawItem);

      log.info(
        `SCRAPED: ${title} | ${parsedUrl.hostname} | ${request.loadedUrl} | ${imageUrls.length} image(s) | Batch: ${itemBatch.length}/${BATCH_SIZE}`,
      );

      await processBatch();
    },
  });

  await crawler.run(seedUrls);

  await uploadRemainingItems();

  await Dataset.exportToCSV(Date.now().toString());

  await cleanupStorage();

  log.info("SUCCESS: Scraping completed successfully");
}

startCrawler();
