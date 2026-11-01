CREATE TABLE "tessellate-online-payments" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"order_reference" varchar(255) NOT NULL,
	"processor_id" varchar(64) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"url" text,
	"status" varchar(16) NOT NULL,
	"amount" jsonb NOT NULL,
	"due_date" varchar(10),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tessellate-payment-processor-settings" (
	"processor_id" varchar(64) NOT NULL,
	"location_id" varchar(255) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config_encrypted" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tessellate-payment-processor-settings_processor_id_location_id_pk" PRIMARY KEY("processor_id","location_id")
);
--> statement-breakpoint
ALTER TABLE "tessellate-online-payments" ADD CONSTRAINT "tessellate-online-payments_order_reference_tessellate-orders_reference_id_fk" FOREIGN KEY ("order_reference") REFERENCES "public"."tessellate-orders"("reference_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tessellate-online-payments-external" ON "tessellate-online-payments" USING btree ("processor_id","external_id");--> statement-breakpoint
CREATE INDEX "tessellate-online-payments-order" ON "tessellate-online-payments" USING btree ("order_reference");