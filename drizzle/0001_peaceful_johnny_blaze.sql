CREATE TABLE "tessellate-plugin-registry" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"version" varchar(255),
	"source_ref" jsonb,
	"sha256" varchar(255),
	"tables" jsonb,
	"installed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "tessellate-system-config" ADD COLUMN "application_id" text;--> statement-breakpoint
ALTER TABLE "tessellate-system-config" ADD COLUMN "location_id" text;--> statement-breakpoint
ALTER TABLE "tessellate-system-config" ADD COLUMN "merchant_id" text;--> statement-breakpoint
ALTER TABLE "tessellate-system-config" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tessellate-system-config" ADD COLUMN "refresh_token_expires_at" timestamp with time zone;