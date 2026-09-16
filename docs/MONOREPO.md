# FBEDS Monorepo Structure

## Overview

This is a pnpm monorepo using Turbo for build orchestration. It's organized into applications and shared packages.

## Directory Structure

```
bedbanks-system/
├── apps/
│   ├── agent/          # B2B Agent Portal (Next.js)
│   ├── api/            # Backend API (to be created)
│   ├── admin/          # Admin Portal (to be created)
│   └── supplier/       # Supplier Extranet (to be created)
│
├── packages/
│   ├── ui/             # Shared UI Components
│   ├── types/          # Shared TypeScript Types
│   ├── validation/     # Zod Validation Schemas
│   └── config/         # Shared Configuration
│
├── docs/               # Documentation
├── .github/            # GitHub Actions & CI/CD
├── pnpm-workspace.yaml # Workspace configuration
├── turbo.json          # Turbo build configuration
└── tsconfig.json       # Root TypeScript configuration
```

## Getting Started

### Installation

```bash
# Install pnpm if not already installed
npm install -g pnpm

# Install all dependencies
pnpm install
```

### Development

```bash
# Run all apps in development mode
pnpm dev

# Run specific app
cd apps/agent
pnpm dev
```

### Building

```bash
# Build all packages and apps (respects dependency order)
pnpm build

# Build specific workspace
cd packages/ui
pnpm build
```

### Scripts

Available scripts in root `package.json`:

- `pnpm dev` - Start all apps in development mode (parallel)
- `pnpm build` - Build all packages and apps
- `pnpm lint` - Run linting across all workspaces
- `pnpm type-check` - Run TypeScript type checking
- `pnpm test` - Run tests across all workspaces
- `pnpm format` - Format code with Prettier

## Workspace Dependencies

### Using Workspace Protocol

When one package depends on another in the same monorepo, use the `workspace:*` protocol:

```json
{
  "dependencies": {
    "@bedbanks/types": "workspace:*",
    "react": "workspace:*"
  }
}
```

### Internal Imports

Use path aliases defined in `tsconfig.json`:

```typescript
// Import from ui package
import { Button } from '@ui/components/Button'

// Import from types package
import type { Hotel } from '@types/domain/hotel'

// Import from validation package
import { hotelSchema } from '@validation/schemas/hotel'

// Import from config package
import { API_BASE_URL } from '@config/constants'
```

## Turbo Build Pipeline

Turbo orchestrates builds with dependency awareness:

- **build**: Depends on all dependency builds completing first
- **dev**: Runs all apps in parallel (no caching)
- **lint**: Caches results for faster re-runs
- **type-check**: Runs TypeScript type checking
- **test**: Runs tests with output caching

## Adding New Workspaces

### Adding a new app

```bash
mkdir apps/new-app
cd apps/new-app
# Create package.json and src/
```

### Adding a new package

```bash
mkdir packages/new-package
cd packages/new-package
# Create package.json and src/
```

Both will be automatically included by pnpm due to the workspace configuration.

## Tips

- Always run scripts from the monorepo root unless working in a specific workspace
- Turbo caches build artifacts - use `pnpm build --force` to rebuild without cache
- TypeScript path aliases enable IDE autocomplete across packages
- Each workspace has its own `tsconfig.json` that extends the root

## Next Steps

1. ✅ Monorepo foundation established
2. ⬜ Backend API setup (Phase 1)
3. ⬜ Database & Prisma schema (Phase 2)
4. ⬜ Authentication & Authorization (Phase 3)
5. ⬜ Business logic implementation (Phase 4+)
