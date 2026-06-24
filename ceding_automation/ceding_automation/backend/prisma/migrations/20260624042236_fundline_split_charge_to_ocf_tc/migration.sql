/*
  Warnings:

  - You are about to drop the column `fundCharge` on the `checklist_fund_lines` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "checklist_fund_lines" DROP COLUMN "fundCharge",
ADD COLUMN     "ocf" DECIMAL(8,4),
ADD COLUMN     "transactionCosts" DECIMAL(8,4);
