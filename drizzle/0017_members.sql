CREATE TABLE "tessellate-member-sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"member_id" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tessellate-member-sources" (
	"plugin" text NOT NULL,
	"provider" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"signup" text,
	"config" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tessellate-member-sources_plugin_provider_pk" PRIMARY KEY("plugin","provider")
);
--> statement-breakpoint
CREATE TABLE "tessellate-members" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"plugin" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tessellate-member-sessions" ADD CONSTRAINT "tessellate-member-sessions_member_id_tessellate-members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."tessellate-members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tessellate_member_sessions_member" ON "tessellate-member-sessions" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tessellate_members_identity" ON "tessellate-members" USING btree ("plugin","provider","external_id");--> statement-breakpoint
CREATE INDEX "tessellate_members_plugin_status" ON "tessellate-members" USING btree ("plugin","status");