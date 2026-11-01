CREATE TABLE "tessellate-auth-account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tessellate-auth-providers" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"plugin_name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tessellate-auth-session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "tessellate-auth-session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "tessellate-auth-user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"username" text,
	"display_username" text,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	CONSTRAINT "tessellate-auth-user_email_unique" UNIQUE("email"),
	CONSTRAINT "tessellate-auth-user_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "tessellate-auth-verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tessellate-customers" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"given_name" text,
	"family_name" text,
	"company_name" text,
	"email" text,
	"phone_number" text,
	"address" jsonb,
	"birthday" varchar(10),
	"note" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tessellate-setup-state" (
	"id" integer PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tessellate-devices-config" ALTER COLUMN "square_location" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "tessellate-devices-config" ADD COLUMN "device_token_hash" text;--> statement-breakpoint
ALTER TABLE "tessellate-auth-account" ADD CONSTRAINT "tessellate-auth-account_user_id_tessellate-auth-user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."tessellate-auth-user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tessellate-auth-session" ADD CONSTRAINT "tessellate-auth-session_user_id_tessellate-auth-user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."tessellate-auth-user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tessellate-devices-config" ADD CONSTRAINT "tessellate-devices-config_device_token_hash_unique" UNIQUE("device_token_hash");