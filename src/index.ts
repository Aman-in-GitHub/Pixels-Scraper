import { CheerioCrawler, Dataset, log, PlaywrightCrawler, RequestQueue } from "crawlee";
import { parse } from "tldts";

import { BATCH_SIZE, EXCLUDE_PATTERNS } from "@/lib/constants.js";
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
const batchContext: BatchContext = { itemBatch: [], pendingUploads: [] };
const failedUrls = loadNormalizedUrlSet("failed_urls.txt");
const cachedUrls = loadNormalizedUrlSet("cache.txt");
const seedUrls = loadSeedUrls("seed.txt", failedUrls, cachedUrls);

const uploadBatchHandler = (items: RawItem[]) =>
  uploadBatch(items, (urls, reason) => addToCache(cachedUrls, urls, reason));

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

    preNavigationHooks: [
      async (_ctx, gotOptions) => {
        gotOptions.http2 = false;
        gotOptions.https = {
          ...gotOptions.https,
          rejectUnauthorized: false,
          checkServerIdentity: () => undefined,
        };
      },
    ],

    failedRequestHandler: async ({ request, error }) => {
      const errorMessage = error instanceof Error ? error.message : String(error ?? "");
      const isTlsIdentityFailure =
        errorMessage.includes("Cannot destructure property 'subject'") ||
        errorMessage.includes("checkServerIdentity");

      if (isTlsIdentityFailure) {
        log.warning(`Cheerio TLS failure, retrying with Playwright: ${request.url}`);
        await playwrightQueue.addRequest({
          url: request.url,
          uniqueKey: `playwright-fallback-${request.uniqueKey}`,
        });
        return;
      }

      await addToFailedUrls(failedUrls, request.url, "Cheerio: too many retries");
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

      log.info(
        `[CHEERIO] ${title} | ${parsedUrl.hostname} | ${imageUrls.length} image(s) | Batch: ${batchContext.itemBatch.length}/${BATCH_SIZE}`,
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
        log.info(`SKIPPING (cached): ${request.loadedUrl}`);
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

      log.info(
        `[PLAYWRIGHT] ${title} | ${parsedUrl.hostname} | ${imageUrls.length} image(s) | Batch: ${batchContext.itemBatch.length}/${BATCH_SIZE}`,
      );

      processBatch(batchContext, BATCH_SIZE, uploadBatchHandler);
    },
  });

  await Promise.all([cheerioCrawler.run(seedUrls), playwrightCrawler.run([])]);

  await flushPendingUploads(batchContext, uploadBatchHandler);

  await Dataset.exportToCSV(Date.now().toString());

  await cleanupStorage();

  log.info("SUCCESS: Scraping completed successfully");
}

startCrawler();
