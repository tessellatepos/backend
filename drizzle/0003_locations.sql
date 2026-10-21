CREATE TABLE "tessellate-locations" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"address" jsonb NOT NULL,
	"currency" varchar(3) NOT NULL,
	"phone_number" text,
	"website_url" text,
	"email" text,
	"hours" jsonb,
	"logo_url" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
