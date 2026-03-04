import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  timestamp,
  doublePrecision,
  integer,
  numeric,
  index,
} from "drizzle-orm/pg-core";

export const scrapedImages = pgTable(
  "scraped_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    url: text("url").notNull().unique(),
    hostname: text("hostname").notNull(),
    domain: text("domain").notNull(),
    title: text("title"),
    favicon: text("favicon"),
    images: jsonb("images").default(sql`'[]'::jsonb`),
    isProcessed: boolean("is_processed").default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index("idx_scraped_images_is_processed").on(t.isProcessed),
    index("idx_scraped_images_created_at").on(t.createdAt),
    index("idx_scraped_images_updated_at").on(t.updatedAt),
    index("idx_scraped_images_hostname").on(t.hostname),
    index("idx_scraped_images_domain").on(t.domain),
    index("idx_scraped_images_processed_created").on(t.isProcessed, t.createdAt),
    index("idx_scraped_images_domain_created").on(t.domain, t.createdAt),
  ],
);

export const embeddedImages = pgTable(
  "embedded_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scrapedImagesId: uuid("scraped_images_id")
      .notNull()
      .references(() => scrapedImages.id),
    url: text("url").notNull(),
    hostname: text("hostname").notNull(),
    domain: text("domain").notNull(),
    title: text("title"),
    favicon: text("favicon"),
    images: jsonb("images").default(sql`'[]'::jsonb`),
    embedding: doublePrecision("embedding").array().notNull(),
    bbox: doublePrecision("bbox").array().notNull(),
    embeddedImage: text("embedded_image").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index("idx_embedded_images_scraped_id").on(t.scrapedImagesId),
    index("idx_embedded_images_url").on(t.url),
    index("idx_embedded_images_hostname").on(t.hostname),
    index("idx_embedded_images_domain").on(t.domain),
    index("idx_embedded_images_embedded_image").on(t.embeddedImage),
    index("idx_embedded_images_created_at").on(t.createdAt),
    index("idx_embedded_images_host_created").on(t.hostname, t.createdAt),
    index("idx_embedded_images_domain_created").on(t.domain, t.createdAt),
  ],
);

export const embeddedVideos = pgTable(
  "embedded_videos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    url: text("url").notNull(),
    hostname: text("hostname").notNull(),
    domain: text("domain").notNull(),
    title: text("title"),
    favicon: text("favicon"),
    embedding: doublePrecision("embedding").array().notNull(),
    bbox: doublePrecision("bbox").array().notNull(),
    embeddedVideo: text("embedded_video").notNull(),
    frameNumber: integer("frame_number").notNull(),
    timestamp: numeric("timestamp", { precision: 10, scale: 3 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index("idx_embedded_videos_url").on(t.url),
    index("idx_embedded_videos_hostname").on(t.hostname),
    index("idx_embedded_videos_domain").on(t.domain),
    index("idx_embedded_videos_embedded_video").on(t.embeddedVideo),
    index("idx_embedded_videos_created_at").on(t.createdAt),
    index("idx_embedded_videos_host_created").on(t.hostname, t.createdAt),
    index("idx_embedded_videos_domain_created").on(t.domain, t.createdAt),
    index("idx_embedded_videos_video_frame").on(t.embeddedVideo, t.frameNumber),
    index("idx_embedded_videos_video_ts").on(t.embeddedVideo, t.timestamp),
  ],
);
