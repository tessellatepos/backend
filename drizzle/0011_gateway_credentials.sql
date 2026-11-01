CREATE TABLE "tessellate-api-credentials" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"scopes" jsonb NOT NULL,
	"location_ids" jsonb NOT NULL,
	"origins" jsonb NOT NULL,
	"rate_limit_per_minute" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"webhook_url" text,
	"webhook_secret_encrypted" text,
	"secret_hash" text NOT NULL,
	"previous_secret_hash" text,
	"previous_secret_expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
