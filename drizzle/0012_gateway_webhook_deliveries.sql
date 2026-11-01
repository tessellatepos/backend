CREATE TABLE "tessellate-webhook-deliveries" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"event_id" varchar(64) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"credential_id" varchar(64) NOT NULL,
	"body" text NOT NULL,
	"status" varchar(16) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_status_code" integer,
	"last_error" varchar(200),
	"replay_of" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "tessellate-webhook-deliveries-due" ON "tessellate-webhook-deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "tessellate-webhook-deliveries-credential" ON "tessellate-webhook-deliveries" USING btree ("credential_id","created_at");