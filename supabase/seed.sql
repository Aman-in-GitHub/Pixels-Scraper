CREATE EXTENSION IF NOT EXISTS "pgcrypto";


CREATE TABLE IF NOT EXISTS scraped_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT NOT NULL UNIQUE,
    hostname TEXT NOT NULL,
    domain TEXT NOT NULL,
    title TEXT,
    favicon TEXT,
    images JSONB DEFAULT '[]'::jsonb,
    screenshot TEXT DEFAULT '',
    is_processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE scraped_images ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_scraped_images_is_processed
    ON scraped_images (is_processed);
CREATE INDEX IF NOT EXISTS idx_scraped_images_created_at
    ON scraped_images (created_at);


CREATE TABLE IF NOT EXISTS embedded_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scraped_images_id UUID NOT NULL REFERENCES scraped_images(id),
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    domain TEXT NOT NULL,
    title TEXT,
    favicon TEXT,
    images JSONB DEFAULT '[]'::jsonb,
    screenshot TEXT DEFAULT '',
    embedding FLOAT[] NOT NULL,
    bbox FLOAT[] NOT NULL,
    embedded_image TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE embedded_images ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_embedded_images_hostname
    ON embedded_images (hostname);
CREATE INDEX IF NOT EXISTS idx_embedded_images_embedded_image
    ON embedded_images (embedded_image);
CREATE INDEX IF NOT EXISTS idx_embedded_images_created_at
    ON embedded_images (created_at);


CREATE TABLE IF NOT EXISTS embedded_videos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT NOT NULL,
    hostname TEXT NOT NULL,
    domain TEXT NOT NULL,
    title TEXT,
    favicon TEXT,
    screenshot TEXT DEFAULT '',
    embedding FLOAT[] NOT NULL,
    bbox FLOAT[] NOT NULL,
    embedded_video TEXT NOT NULL,
    frame_number INTEGER NOT NULL,
    timestamp DECIMAL(10,3) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE embedded_videos ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_embedded_videos_hostname
    ON embedded_videos (hostname);
CREATE INDEX IF NOT EXISTS idx_embedded_videos_embedded_video
    ON embedded_videos (embedded_video);
CREATE INDEX IF NOT EXISTS idx_embedded_videos_created_at
    ON embedded_videos (created_at);


CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';


CREATE TRIGGER update_scraped_images_updated_at
    BEFORE UPDATE ON scraped_images
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_embedded_images_updated_at
    BEFORE UPDATE ON embedded_images
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_embedded_videos_updated_at
    BEFORE UPDATE ON embedded_videos
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
