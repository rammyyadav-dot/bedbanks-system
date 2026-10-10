-- Preserve Hotel ids, references and all historical operational records.
ALTER TYPE "ContentStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';
