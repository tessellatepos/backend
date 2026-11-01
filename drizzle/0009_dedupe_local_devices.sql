-- Keep one LOCAL till per location before the unique index is added. Prefer the
-- till that already holds a device token (it is in use), then the oldest row.
DELETE FROM "tessellate-devices-config" AS d
USING (
    SELECT id,
        ROW_NUMBER() OVER (
            PARTITION BY square_location
            ORDER BY (device_token_hash IS NULL), entry_created_at, id
        ) AS rn
    FROM "tessellate-devices-config"
    WHERE device_type::text = 'LOCAL' AND square_location IS NOT NULL
) AS ranked
WHERE d.id = ranked.id AND ranked.rn > 1;
