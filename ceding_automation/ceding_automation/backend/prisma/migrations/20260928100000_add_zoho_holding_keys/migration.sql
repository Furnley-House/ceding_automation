-- Records which Holdings_List rows a case put on its Zoho Plan, as the
-- identity keys the export matches on. Lets a holding deleted from the
-- checklist be deleted from the Plan too, without ever touching a row that
-- another team or a workflow added.
ALTER TABLE "cases" ADD COLUMN "zohoHoldingKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
