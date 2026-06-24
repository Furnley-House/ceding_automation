-- LOA bookkeeping written from Stage 2 SendLOAWorkspace. Without these
-- columns the PATCH /:id endpoint silently dropped loaNotes / loaMethod /
-- loaTrackingRef / pdfReceivedDate from the request body — the UI showed
-- a success toast then the values disappeared on reload.
ALTER TABLE "cases" ADD COLUMN "loaNotes" TEXT;
ALTER TABLE "cases" ADD COLUMN "loaMethod" TEXT;
ALTER TABLE "cases" ADD COLUMN "loaTrackingRef" TEXT;
ALTER TABLE "cases" ADD COLUMN "loaReceivedAt" TIMESTAMP(3);
