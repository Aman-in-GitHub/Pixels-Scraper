import fs from "node:fs";

const seedFile = "seed.txt";
const failedFile = "failed_urls.txt";

if (!fs.existsSync(seedFile)) {
  console.log(`Error: ${seedFile} not found`);
  process.exit(1);
}

if (!fs.existsSync(failedFile)) {
  console.log(`No ${failedFile} found - nothing to clean`);
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
  console.log(`${failedFile} is empty - nothing to clean`);
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

console.log(`Cleaned ${seedFile}`);
console.log(`Kept ${cleanUrls.length} URLs`);
console.log(`Removed ${originalUrls.length - cleanUrls.length} URLs`);
console.log(`Deleted ${failedFile}`);
