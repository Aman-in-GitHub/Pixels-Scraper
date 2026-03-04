import type { Page } from "playwright";

import { log } from "crawlee";
import crypto from "crypto";

export function isDevMode() {
  return process.env.NODE_ENV === "development";
}

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
    log.warning(`Invalid URL skipped: ${url} - ${error}`);
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
