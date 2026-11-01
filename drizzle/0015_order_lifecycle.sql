ALTER TABLE "tessellate-orders" ADD COLUMN "created_by_credential" varchar(255);--> statement-breakpoint
ALTER TABLE "tessellate-orders" ADD COLUMN "invoiced_at" timestamp with time zone;