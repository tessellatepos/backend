CREATE TYPE "public"."device_type" AS ENUM('TERMINAL', 'MOBILE_READER');--> statement-breakpoint
CREATE TYPE "public"."pricing_type" AS ENUM('FIXED', 'VARIABLE');--> statement-breakpoint
CREATE TABLE "tessellate-catalog-categories" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" text,
	"parent_category_id" varchar(255),
	"image_id" varchar(255),
	"image_url" text,
	"provider_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tessellate-catalog-item-categories" (
	"item_id" varchar(255) NOT NULL,
	"category_id" varchar(255) NOT NULL,
	CONSTRAINT "tessellate-catalog-item-categories_item_id_category_id_pk" PRIMARY KEY("item_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "tessellate-catalog-item-locations" (
	"item_id" varchar(255) NOT NULL,
	"location_id" varchar(255) NOT NULL,
	CONSTRAINT "tessellate-catalog-item-locations_item_id_location_id_pk" PRIMARY KEY("item_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "tessellate-catalog-item-variations" (
	"variation_id" varchar(255) PRIMARY KEY NOT NULL,
	"item_id" varchar(255) NOT NULL,
	"name" text,
	"sku" varchar(255),
	"upc" varchar(255),
	"ordinal" text,
	"pricing_type" "pricing_type",
	"price_money" jsonb,
	"location_overrides" jsonb,
	"track_inventory" boolean,
	"provider_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tessellate-catalog-items" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" text,
	"display_name" text,
	"label_color" varchar(20),
	"is_taxable" boolean,
	"is_archived" boolean DEFAULT false,
	"image" text,
	"provider_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tessellate-devices-config" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"entry_created_at" timestamp with time zone DEFAULT now(),
	"paring_code" varchar(8),
	"code_created_at" timestamp with time zone DEFAULT now(),
	"paired_at" timestamp with time zone,
	"square_location" varchar(14),
	"customer_facing" boolean,
	"device_hardware_id" text,
	"device_type" "device_type"
);
--> statement-breakpoint
CREATE TABLE "tessellate-system-config" (
	"id" integer PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tessellate-orders" (
	"id" text,
	"location_id" text NOT NULL,
	"reference_id" varchar(255) PRIMARY KEY NOT NULL,
	"source_name" varchar(255),
	"customer_id" varchar(255),
	"line_items" jsonb,
	"taxes" jsonb,
	"discounts" jsonb NOT NULL,
	"net_amount" jsonb,
	"rounding_adjustment" jsonb,
	"tenders" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"state" varchar(20),
	"version" integer,
	"total_money" jsonb,
	"total_tax_money" jsonb,
	"total_discount_money" jsonb,
	"total_tip_money" jsonb,
	"total_service_charge_money" jsonb
);
--> statement-breakpoint
ALTER TABLE "tessellate-catalog-item-categories" ADD CONSTRAINT "tessellate-catalog-item-categories_item_id_tessellate-catalog-items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."tessellate-catalog-items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tessellate-catalog-item-categories" ADD CONSTRAINT "tessellate-catalog-item-categories_category_id_tessellate-catalog-categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."tessellate-catalog-categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tessellate-catalog-item-locations" ADD CONSTRAINT "tessellate-catalog-item-locations_item_id_tessellate-catalog-items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."tessellate-catalog-items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tessellate-catalog-item-variations" ADD CONSTRAINT "tessellate-catalog-item-variations_item_id_tessellate-catalog-items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."tessellate-catalog-items"("id") ON DELETE no action ON UPDATE no action;