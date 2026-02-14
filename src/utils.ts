import type { Page } from "playwright";

import { log } from "crawlee";
import crypto from "crypto";

import { BUCKET_NAME } from "./constants.js";
import { supabase } from "./supabase.js";

export function isDevMode() {
  return process.env.NODE_ENV === "development";
}

export function generateRandomString() {
  return crypto.randomBytes(16).toString("hex");
}

export async function shouldSkipPage(page: Page): Promise<boolean> {
  try {
    const content = await page.content();

    if (!content) return true;

    if (!content.trim().startsWith("<!DOCTYPE html") && !content.toLowerCase().includes("<html")) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

export function isValidImageUrl(src: string) {
  if (src.startsWith("data:")) return false;

  if (src.startsWith("blob:")) return false;

  if (!src || src.length < 10) return false;

  if (!src.startsWith("http://") && !src.startsWith("https://")) return false;

  if (src.toLowerCase().includes(".svg")) return false;

  if (src.toLowerCase().includes(".gif")) return false;

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

export async function scrollToBottom(page: Page, maxScrolls: number = 10): Promise<void> {
  let scrollCount = 0;
  let currentHeight = 0;
  let previousHeight = 0;

  do {
    previousHeight = currentHeight;

    await page.evaluate(() => window.scrollBy(0, window.innerHeight));

    await page.waitForTimeout(500);

    currentHeight = await page.evaluate(() =>
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    );

    scrollCount++;
  } while (currentHeight > previousHeight && scrollCount < maxScrolls);
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

    return urlObj.toString();
  } catch (error) {
    log.warning(`Invalid URL skipped: ${url} - ${error}`);
    return null;
  }
}

export async function uploadScreenshotToStorage(
  buffer: Buffer,
  url: string,
): Promise<string | null> {
  try {
    const { data: bucketData, error: getError } = await supabase.storage.getBucket(BUCKET_NAME);

    if (getError || !bucketData) {
      const { error: createError } = await supabase.storage.createBucket(BUCKET_NAME, {
        public: true,
        allowedMimeTypes: ["image/*"],
      });

      if (createError) {
        log.error(`Error creating bucket '${BUCKET_NAME}': ${createError.message}`);
        return null;
      }
    }

    const fileName = `${crypto.createHash("sha256").update(url).digest("hex")}.png`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(fileName, buffer, {
        upsert: true,
        contentType: "image/png",
      });

    if (uploadError) {
      log.error(`Error uploading screenshot for ${url}: ${uploadError.message}`);
      return null;
    }

    const { data: publicUrlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(fileName);

    return publicUrlData.publicUrl;
  } catch (error) {
    log.error(`Failed to upload screenshot for ${url}: ${error}`);
    return null;
  }
}
