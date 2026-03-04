import { PAGE_TYPES_TO_EXCLUDE, TRUSTED_WEBSITES_TO_EXCLUDE } from "@/lib/constants";

const PAGE_TYPES_TO_EXCLUDE_SET = new Set(PAGE_TYPES_TO_EXCLUDE.map((ext) => ext.toLowerCase()));

const trustedRules = Array.from(
  new Set(TRUSTED_WEBSITES_TO_EXCLUDE.map((rule) => rule.toLowerCase())),
);

const trustedHostRules = trustedRules.filter((rule) => !rule.includes("/"));
const trustedPathRules = trustedRules.filter((rule) => rule.includes("/"));

const trustedHostSet = new Set(trustedHostRules.filter((rule) => rule.includes(".")));
const trustedTldSet = new Set(trustedHostRules.filter((rule) => !rule.includes(".")));

function isExcludedHost(hostname: string): boolean {
  if (trustedHostSet.has(hostname)) return true;

  const segments = hostname.split(".");
  if (segments.length === 0) return false;

  for (let i = 1; i < segments.length; i += 1) {
    const suffix = segments.slice(i).join(".");
    if (trustedHostSet.has(suffix)) return true;
  }

  const tld = segments[segments.length - 1];
  if (!tld) return false;
  return trustedTldSet.has(tld);
}

function hasExcludedExtension(pathname: string): boolean {
  const fileName = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dotIndex = fileName.lastIndexOf(".");

  if (dotIndex <= 0) return false;

  const ext = fileName.slice(dotIndex + 1).toLowerCase();
  return PAGE_TYPES_TO_EXCLUDE_SET.has(ext);
}

export function shouldExcludeCrawlUrl(url: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();

  if (!hostname) return true;
  if (isExcludedHost(hostname)) return true;

  const hostWithPath = `${hostname}${pathname}`;
  if (trustedPathRules.some((rule) => hostWithPath.startsWith(rule))) return true;

  return hasExcludedExtension(pathname);
}
