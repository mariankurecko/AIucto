# Marian AI OS Core

Reusable AI OS core for document ingestion, OCR, classification, monthly accounting packaging, and cleanup workflows. The repository is structured as a workspace monorepo so the processing core can be reused later by other applications without coupling business logic to the CLI layer.

## Architecture

```text
apps/
  cli/               Thin command entrypoints
packages/
  core/              Reusable workflow entrypoints
  google/            Gmail, Drive, OAuth, Sheets integrations
  ocr/               OCR and extraction helpers
  classification/    Config-driven document rules
  types/             Shared TypeScript types
config/
  equisix.yaml       Account-specific identity and classification rules
src/
  invoice-monthly/   Legacy implementation layer used by packages during migration
```

The intended boundary is:

- `apps/cli` parses arguments and prints structured JSON logs.
- `packages/core` exports `runInvoiceMonthly()`, `runCleanupMonth()`, and `runSecondPass()`.
- `packages/classification` owns account-specific invoice and receipt validation rules.

## Local Setup

```bash
npm install
cp .env.example .env
```

Required secret material stays outside git:

- Google OAuth client credentials
- Google token storage
- OpenRouter API key when OCR/extraction uses external models

## Commands

```bash
npm run validate
npm run context -- --account equisix --project coinomatic
npm run invoice:monthly -- --account equisix --period 2026-06
npm run invoice:monthly-second-pass -- --account equisix --period 2026-06 --ocr
npm run invoice:cleanup-month -- --account equisix --period 2026-06
npm run typecheck
```

## Library Usage

`packages/core/src/index.ts` exposes reusable entrypoints for other applications:

- `runInvoiceMonthly()`
- `runCleanupMonth()`
- `runSecondPass()`

The current implementation uses a local filesystem storage adapter. The core API takes explicit parameters so another storage adapter can be introduced later without changing CLI behavior.

## GitHub Readiness

- Runtime outputs and secrets belong in `data/`, `tokens/`, `secrets/`, or `.env` files and are gitignored.
- Account-specific rules live in `config/<account>.yaml`.
- CLI output is structured JSON for easier automation and production logging.
