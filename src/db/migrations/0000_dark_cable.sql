CREATE TABLE "embedded_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scraped_images_id" uuid NOT NULL,
	"url" text NOT NULL,
	"hostname" text NOT NULL,
	"domain" text NOT NULL,
	"title" text,
	"favicon" text,
	"images" jsonb DEFAULT '[]'::jsonb,
	"embedding" double precision[] NOT NULL,
	"bbox" double precision[] NOT NULL,
	"embedded_image" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "embedded_videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"hostname" text NOT NULL,
	"domain" text NOT NULL,
	"title" text,
	"favicon" text,
	"embedding" double precision[] NOT NULL,
	"bbox" double precision[] NOT NULL,
	"embedded_video" text NOT NULL,
	"frame_number" integer NOT NULL,
	"timestamp" numeric(10, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scraped_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"hostname" text NOT NULL,
	"domain" text NOT NULL,
	"title" text,
	"favicon" text,
	"images" jsonb DEFAULT '[]'::jsonb,
	"is_processed" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "scraped_images_url_unique" UNIQUE("url")
);
--> statement-breakpoint
ALTER TABLE "embedded_images" ADD CONSTRAINT "embedded_images_scraped_images_id_scraped_images_id_fk" FOREIGN KEY ("scraped_images_id") REFERENCES "public"."scraped_images"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_embedded_images_scraped_id" ON "embedded_images" USING btree ("scraped_images_id");--> statement-breakpoint
CREATE INDEX "idx_embedded_images_url" ON "embedded_images" USING btree ("url");--> statement-breakpoint
CREATE INDEX "idx_embedded_images_hostname" ON "embedded_images" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "idx_embedded_images_domain" ON "embedded_images" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "idx_embedded_images_embedded_image" ON "embedded_images" USING btree ("embedded_image");--> statement-breakpoint
CREATE INDEX "idx_embedded_images_created_at" ON "embedded_images" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_embedded_images_host_created" ON "embedded_images" USING btree ("hostname","created_at");--> statement-breakpoint
CREATE INDEX "idx_embedded_images_domain_created" ON "embedded_images" USING btree ("domain","created_at");--> statement-breakpoint
CREATE INDEX "idx_embedded_videos_url" ON "embedded_videos" USING btree ("url");--> statement-breakpoint
CREATE INDEX "idx_embedded_videos_hostname" ON "embedded_videos" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "idx_embedded_videos_domain" ON "embedded_videos" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "idx_embedded_videos_embedded_video" ON "embedded_videos" USING btree ("embedded_video");--> statement-breakpoint
CREATE INDEX "idx_embedded_videos_created_at" ON "embedded_videos" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_embedded_videos_host_created" ON "embedded_videos" USING btree ("hostname","created_at");--> statement-breakpoint
CREATE INDEX "idx_embedded_videos_domain_created" ON "embedded_videos" USING btree ("domain","created_at");--> statement-breakpoint
CREATE INDEX "idx_embedded_videos_video_frame" ON "embedded_videos" USING btree ("embedded_video","frame_number");--> statement-breakpoint
CREATE INDEX "idx_embedded_videos_video_ts" ON "embedded_videos" USING btree ("embedded_video","timestamp");--> statement-breakpoint
CREATE INDEX "idx_scraped_images_is_processed" ON "scraped_images" USING btree ("is_processed");--> statement-breakpoint
CREATE INDEX "idx_scraped_images_created_at" ON "scraped_images" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_scraped_images_updated_at" ON "scraped_images" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_scraped_images_hostname" ON "scraped_images" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "idx_scraped_images_domain" ON "scraped_images" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "idx_scraped_images_processed_created" ON "scraped_images" USING btree ("is_processed","created_at");--> statement-breakpoint
CREATE INDEX "idx_scraped_images_domain_created" ON "scraped_images" USING btree ("domain","created_at");