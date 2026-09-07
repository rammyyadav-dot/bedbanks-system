# FBEDS — Enterprise B2B Bedbank Platform

> **Repository:** `bedbanks-system`  
> **Product:** FBEDS  
> **Platform:** B2B Hotel Bedbank / Wholesale Hotel Distribution  
> **Status:** Active Development / MVP → Enterprise Production  
> **Primary Domain:** `yourbedbank.com`

FBEDS is an enterprise-grade B2B bedbank platform designed to connect hotels, DMCs, suppliers, travel agencies, tour operators, and other travel distribution partners through a centralized hotel inventory, booking, and financial system.

The platform is being developed with an AI-assisted engineering workflow using **Next.js, TypeScript, PostgreSQL/Prisma, pnpm monorepo, Turbo, and AWS**.

## 📋 Quick Start

### Prerequisites
- Node.js 20.0.0 or higher
- pnpm 9.0.0 or higher

### Installation

```bash
# Install pnpm
npm install -g pnpm

# Install dependencies
pnpm install
```

### Development

```bash
# Start all apps in development mode
pnpm dev

# Start specific app
cd apps/agent
pnpm dev
```

### Build

```bash
# Build all apps and packages
pnpm build
```

### Scripts

- `pnpm dev` - Start development servers (parallel)
- `pnpm build` - Build all applications
- `pnpm lint` - Run linting
- `pnpm type-check` - Type checking
- `pnpm test` - Run tests
- `pnpm format` - Format code

## 📁 Project Structure

```
bedbanks-system/
├── apps/
│   ├── agent/         # Agent portal (Next.js)
│   ├── api/           # Backend API (coming)
│   ├── admin/         # Admin console (coming)
│   └── supplier/      # Supplier extranet (coming)
├── packages/
│   ├── ui/            # Shared UI components
│   ├── types/         # Shared TypeScript types
│   ├── validation/    # Zod validation schemas
│   └── config/        # Shared configuration
├── prisma/            # Database schema (coming)
├── infra/             # Infrastructure as Code (coming)
└── .github/           # GitHub Actions & CI/CD
```

See [docs/MONOREPO.md](./docs/MONOREPO.md) for detailed monorepo documentation.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│           CloudFront / WAF                   │
└──────────────────┬──────────────────────────┘
                   │
    ┌──────────────┼──────────────┐
    │              │              │
┌───▼──┐     ┌─────▼────┐   ┌────▼──┐
│Website│    │ Agent    │   │ Supplier
│Portal │    │ Portal   │   │ Extranet
└───┬──┘     └─────┬────┘   └────┬───┘
    └──────────────┼──────────────┘
                   │
           ┌───────▼────────┐
           │  Backend API   │
           │  (REST /v1)    │
           └────────┬───────┘
                    │
         ┌──────────┼──────────┐
         │          │          │
    ┌────▼──┐   ┌───▼──┐  ┌───▼───┐
    │Prisma │   │Redis │  │ SQS   │
    └────┬──┘   └───┬──┘  └───┬───┘
         │          │         │
         └──────┬───┴────┬────┘
                │        │
          ┌─────▼─────┐  │
          │  Aurora   │  │
          │PostgreSQL │  │
          └───────────┘  │
                         │
                    ┌────▼───┐
                    │   S3   │
                    └────────┘
```

## 📚 Documentation

- [Monorepo Guide](./docs/MONOREPO.md) - Workspace setup and structure
- [Architecture](./docs/MONOREPO.md#-architecture) - System architecture
- [Contributing](./CONTRIBUTING.md) - Coming soon
- [API Reference](./docs/api/) - Coming soon

## 🚀 Development Roadmap

### Phase 0: Foundation ✅
- [x] Monorepo setup (pnpm + Turbo)
- [x] Frontend application (Agent Portal)
- [ ] CI/CD pipeline setup
- [ ] ESLint + Prettier configuration

### Phase 1: Backend Foundation ⏳
- [ ] Backend API (NestJS)
- [ ] Authentication (Cognito/JWT)
- [ ] Authorization (RBAC)
- [ ] Multi-tenancy

### Phase 2: Database
- [ ] Prisma schema
- [ ] Aurora PostgreSQL
- [ ] Migrations
- [ ] Seeding

### Phase 3-12: Business Logic
- [ ] Hotel management
- [ ] Booking engine
- [ ] Search functionality
- [ ] Pricing engine
- [ ] Wallet & ledger
- [ ] Supplier integrations
- [ ] And more...

See [docs/ROADMAP.md](./docs/ROADMAP.md) for detailed phase breakdown.

## 🛠️ Tech Stack

**Frontend:**
- Next.js 16.3.3
- React 19.2.4
- TypeScript 5.7.3
- Tailwind CSS 4.3.3

**Monorepo & Build:**
- pnpm 9.0+
- Turbo 2.0+
- TypeScript

**Backend (Coming):**
- Node.js
- NestJS or Express
- Prisma ORM

**Database:**
- PostgreSQL (Aurora in production)

**Infrastructure:**
- AWS (ECS/Fargate, ALB, RDS, etc.)
- Docker

## 🔐 Security

- Never commit `.env` or secrets
- Use AWS Secrets Manager in production
- All sensitive data must be properly encrypted
- See [README.md](./README.md#-security) for security principles

## 📝 License

Private - FBEDS Platform

## 👥 Team

Maintained by the FBEDS engineering team.

---

**Next Step:** See [docs/MONOREPO.md](./docs/MONOREPO.md) for development guide.
