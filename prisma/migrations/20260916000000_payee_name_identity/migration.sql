-- Name becomes the identity. NOTHING is deleted and no Expense row is moved.
--
-- Where two payees already share a name we keep BOTH records exactly as they
-- are, with their entries untouched; only the loser's identity key is
-- suffixed so the unique index can be created. Those pairs can be merged
-- deliberately later, from the UI, with the history in front of you — which
-- is the only safe moment to decide whether two "BIJOY"s are one man.

-- 1. new identity column
ALTER TABLE "Payee" ADD COLUMN IF NOT EXISTS "nameKey" TEXT;

-- 2. fill it. A staff-linked record, else the oldest, keeps the clean key;
--    any same-name record after it gets " #2", " #3" … appended to the KEY
--    ONLY. `name`, `phone`, `role`, `notes` and every entry stay as they are.
WITH ranked AS (
  SELECT "id",
         upper(regexp_replace(btrim("name"), '\s+', ' ', 'g')) AS key,
         row_number() OVER (
           PARTITION BY upper(regexp_replace(btrim("name"), '\s+', ' ', 'g'))
           ORDER BY ("userId" IS NULL), "createdAt" ASC, "id" ASC
         ) AS rn
  FROM "Payee"
)
UPDATE "Payee" p
SET "nameKey" = CASE WHEN r.rn = 1 THEN r.key ELSE r.key || ' #' || r.rn END
FROM ranked r
WHERE p."id" = r."id";

-- 3. a blank name would collide with any other blank name — park it on the id
UPDATE "Payee" SET "nameKey" = 'UNNAMED ' || "id"
WHERE "nameKey" IS NULL OR btrim("nameKey") = '';

-- 4. lock it in
ALTER TABLE "Payee" ALTER COLUMN "nameKey" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Payee_nameKey_key" ON "Payee"("nameKey");

-- 5. the phone stops being the identity. The index goes; every number stays.
DROP INDEX IF EXISTS "Payee_phone_key";
ALTER TABLE "Payee" ALTER COLUMN "phone" DROP NOT NULL;
CREATE INDEX IF NOT EXISTS "Payee_phone_idx" ON "Payee"("phone");