CREATE TABLE "tessellate-provider-config" (
	"id" integer PRIMARY KEY NOT NULL,
	"provider" varchar(32) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
