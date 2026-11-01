-- An IMMUTABLE helper, because Postgres rejects an enum-to-text cast in an
-- index predicate. Migrations run in one transaction, so the LOCAL label added
-- in 0007 cannot appear as a literal here; the text comparison avoids that.
CREATE FUNCTION "tessellate_is_local_till"("d" "device_type") RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $$ SELECT $1::text = 'LOCAL' $$;
--> statement-breakpoint
-- At most one LOCAL till per location, so concurrent creates cannot race.
CREATE UNIQUE INDEX "tessellate_devices_one_local_per_location" ON "tessellate-devices-config" USING btree ("square_location") WHERE "tessellate_is_local_till"("device_type");
