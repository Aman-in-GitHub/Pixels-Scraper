import {
  CheerioCrawler,
  Dataset,
  LogLevel,
  PlaywrightCrawler,
  Request,
  RequestQueue,
  log as crawleeLog,
} from "crawlee";
import { parse } from "tldts";

import { BATCH_SIZE, EXCLUDE_PATTERNS } from "@/lib/constants.js";
import { logger } from "@/lib/logger.js";
import {
  addToCache,
  addToFailedUrls,
  cleanupStorage,
  flushPendingUploads,
  isValidImageUrl,
  loadNormalizedUrlSet,
  loadSeedUrls,
  needsJsRendering,
  processBatch,
  scrollToBottom,
  shouldSkipPage,
  type BatchContext,
  type RawItem,
  uploadBatch,
  validateAndNormalizeUrl,
} from "@/lib/utils.js";

const crawlerLogger = logger.child({ module: "crawler" });

const PLAYWRIGHT_FALLBACK_FLAG = "__playwrightFallbackQueued";

crawleeLog.setLevel(LogLevel.OFF);

const batchContext: BatchContext = { itemBatch: [], pendingUploads: [] };

const cachedUrls = loadNormalizedUrlSet("cache.txt");

const failedUrls = loadNormalizedUrlSet("failed_urls.txt");

const seedUrls = loadSeedUrls("seed.txt", failedUrls, cachedUrls);

const uploadBatchHandler = (items: RawItem[]) =>
  uploadBatch(items, (urls, reason) => addToCache(cachedUrls, urls, reason));

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

function getErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code: unknown }).code ?? "");
  }

  return "";
}

function isTlsNavigationError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  const code = getErrorCode(error).toUpperCase();

  if (
    message.includes("cannot destructure property 'subject'") ||
    message.includes("checkserveridentity")
  ) {
    return true;
  }

  if (code.startsWith("ERR_TLS_") || code.startsWith("CERT_")) {
    return true;
  }

  return (
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  );
}

async function queuePlaywrightFallbackForTlsError(
  request: Request,
  error: unknown,
  playwrightQueue: RequestQueue,
): Promise<boolean> {
  if (!isTlsNavigationError(error)) return false;

  const alreadyQueued = Boolean(request.userData[PLAYWRIGHT_FALLBACK_FLAG]);

  if (alreadyQueued) return true;

  request.userData[PLAYWRIGHT_FALLBACK_FLAG] = true;

  request.noRetry = true;

  crawlerLogger.warn({ url: request.url }, "Cheerio TLS failure, retrying with Playwright");

  await playwrightQueue.addRequest({
    url: request.url,
    uniqueKey: `playwright-fallback-${request.uniqueKey}`,
  });

  return true;
}

async function startCrawler(): Promise<void> {
  await cleanupStorage();

  crawlerLogger.info(
    { cachedCount: cachedUrls.size, failedCount: failedUrls.size },
    "Loaded URL caches",
  );

  crawlerLogger.info({ seedCount: seedUrls.length }, "Starting crawl with filtered seed URLs");

  const cheerioQueue = await RequestQueue.open(`CHEERIO-QUEUE-${Date.now()}`);

  const playwrightQueue = await RequestQueue.open(`PLAYWRIGHT-QUEUE-${Date.now()}`);

  const cheerioCrawler = new CheerioCrawler({
    requestQueue: cheerioQueue,
    maxConcurrency: 20,
    maxRequestRetries: 1,
    requestHandlerTimeoutSecs: 30,

    preNavigationHooks: [
      async (_ctx, gotOptions) => {
        gotOptions.http2 = false;
        gotOptions.https = {
          ...gotOptions.https,
          rejectUnauthorized: false,
          checkServerIdentity: (_hostname, _cert) => undefined,
        };
      },
    ],

    errorHandler: async ({ request }, error) => {
      await queuePlaywrightFallbackForTlsError(request, error, playwrightQueue);
    },

    failedRequestHandler: async ({ request }, error) => {
      const queuedForPlaywright = await queuePlaywrightFallbackForTlsError(
        request,
        error,
        playwrightQueue,
      );
      if (queuedForPlaywright) return;

      await addToFailedUrls(failedUrls, request.url, "Cheerio: too many retries");
    },

    async requestHandler({ request, $, enqueueLinks }) {
      const normalizedLoadedUrl = validateAndNormalizeUrl(request.loadedUrl);

      if (normalizedLoadedUrl && cachedUrls.has(normalizedLoadedUrl)) {
        crawlerLogger.debug({ url: request.loadedUrl }, "Skipping cached URL");
        return;
      }

      if (needsJsRendering($)) {
        crawlerLogger.debug({ url: request.loadedUrl }, "Escalating URL to Playwright");
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
        await addToFailedUrls(failedUrls, request.loadedUrl, "Cheerio: no images found");
        return;
      }

      batchContext.itemBatch.push({
        url: request.loadedUrl,
        hostname: parsedUrl.hostname,
        domain: parsedUrl.domain,
        title,
        favicon,
        images: imageUrls,
      });

      crawlerLogger.info(
        {
          crawler: "cheerio",
          title,
          hostname: parsedUrl.hostname,
          imageCount: imageUrls.length,
          batchSize: batchContext.itemBatch.length,
          batchLimit: BATCH_SIZE,
          url: request.loadedUrl,
        },
        "Page processed",
      );

      processBatch(batchContext, BATCH_SIZE, uploadBatchHandler);
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
      await addToFailedUrls(failedUrls, request.url, "Playwright: too many retries");
    },

    async requestHandler({ request, page, enqueueLinks }) {
      const normalizedLoadedUrl = validateAndNormalizeUrl(request.loadedUrl);

      if (normalizedLoadedUrl && cachedUrls.has(normalizedLoadedUrl)) {
        crawlerLogger.debug({ url: request.loadedUrl }, "Skipping cached URL");
        return;
      }

      await page.waitForLoadState("domcontentloaded");

      const isInvalidPage = await shouldSkipPage(page);

      if (isInvalidPage) {
        await addToFailedUrls(failedUrls, request.loadedUrl, "Invalid page");
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
        await addToFailedUrls(failedUrls, request.loadedUrl, "Playwright: no images found");
        return;
      }

      batchContext.itemBatch.push({
        url: request.loadedUrl,
        hostname: parsedUrl.hostname,
        domain: parsedUrl.domain,
        title,
        favicon: favicon || new URL("/favicon.ico", page.url()).href,
        images: imageUrls,
      });

      crawlerLogger.info(
        {
          crawler: "playwright",
          title,
          hostname: parsedUrl.hostname,
          imageCount: imageUrls.length,
          batchSize: batchContext.itemBatch.length,
          batchLimit: BATCH_SIZE,
          url: request.loadedUrl,
        },
        "Page processed",
      );

      processBatch(batchContext, BATCH_SIZE, uploadBatchHandler);
    },
  });

  await Promise.all([cheerioCrawler.run(seedUrls), playwrightCrawler.run([])]);

  await flushPendingUploads(batchContext, uploadBatchHandler);

  await Dataset.exportToCSV(Date.now().toString());

  await cleanupStorage();

  crawlerLogger.info("Scraping completed successfully");
}

startCrawler();
