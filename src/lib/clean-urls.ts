import fs from "node:fs";

import { logger } from "@/lib/logger";

const seedFile = "seed.txt";
const failedFile = "failed_urls.txt";

const cleanUrlsLogger = logger.child({ module: "clean-urls" });

if (!fs.existsSync(seedFile)) {
  cleanUrlsLogger.error({ file: seedFile }, "Required seed file not found");
  process.exit(1);
}

if (!fs.existsSync(failedFile)) {
  cleanUrlsLogger.info({ file: failedFile }, "Nothing to clean: failed URL file missing");
  process.exit(0);
}

const failedUrls = new Set(
  fs
    .readFileSync(failedFile, "utf-8")
    .split("\n")
    .map((line) => line.trim().replace(/\/$/, ""))
    .filter((line) => line),
);

if (failedUrls.size === 0) {
  cleanUrlsLogger.info({ file: failedFile }, "Nothing to clean: failed URL file is empty");
  fs.unlinkSync(failedFile);
  process.exit(0);
}

const originalUrls = fs
  .readFileSync(seedFile, "utf-8")
  .split("\n")
  .filter((line) => line.trim());

const cleanUrls = originalUrls
  .map((line) => line.trim().replace(/\/$/, ""))
  .filter((url) => url && !failedUrls.has(url))
  .map((url) => url + "\n");

fs.writeFileSync(seedFile, cleanUrls.join(""));
fs.unlinkSync(failedFile);

cleanUrlsLogger.info(
  {
    seedFile,
    failedFile,
    keptCount: cleanUrls.length,
    removedCount: originalUrls.length - cleanUrls.length,
  },
  "Cleaned seed file and removed failed URL file",
);
