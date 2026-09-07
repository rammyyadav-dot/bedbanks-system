Below is a **production-oriented README.md** you can replace the current v0-generated README with. I’ve kept the v0 workflow, but reframed the repository as the **FBEDS enterprise B2B bedbank platform**, with clear architecture, environments, development rules, security, testing, and roadmap.

````markdown
# FBEDS — Enterprise B2B Bedbank Platform

> **Repository:** `bedbanks-system`  
> **Product:** FBEDS  
> **Platform:** B2B Hotel Bedbank / Wholesale Hotel Distribution  
> **Status:** Active Development / MVP → Enterprise Production  
> **Primary Domain:** `yourbedbank.com`

FBEDS is an enterprise-grade B2B bedbank platform designed to connect hotels, DMCs, suppliers, travel agencies, tour operators, and other travel distribution partners through a centralized hotel inventory, contracting, pricing, search, booking, and financial platform.

The platform is being developed with an AI-assisted engineering workflow using **Next.js, v0, GitHub, Copilot/Codex/Cursor, TypeScript, PostgreSQL/Prisma and AWS**.

---

# 1. Product Vision

FBEDS aims to provide a modern wholesale hotel distribution platform capable of supporting:

- Hotel inventory
- Hotel contracting
- Supplier contracts
- Room types
- Rates
- Availability
- Markups
- Dynamic pricing
- Hotel search
- Quotes
- Reservations
- Cancellations
- Vouchers
- Supplier integrations
- Agent accounts
- Multi-tenancy
- Wallets
- Credit limits
- Commissions
- Financial ledger
- Reporting
- Supplier extranet
- Admin operations
- API/XML distribution

The long-term objective is to build an enterprise platform comparable in functional scope to modern global B2B accommodation distribution platforms.

---

# 2. Platform Architecture

The target FBEDS architecture is:

```text
                         INTERNET
                            |
                    CloudFront / WAF
                            |
          +-----------------+-----------------+
          |                 |                 |
       Website          Agent Portal      Supplier Portal
          |                 |                 |
          +-----------------+-----------------+
                            |
                       Backend API
                            |
                    Domain / Services
                            |
                         Prisma
                            |
                  Aurora PostgreSQL
                            |
          +---------+-------+--------+---------+
          |         |                |         |
        Redis      SQS              S3      Cognito
        Cache    Async Jobs        Assets       Auth
          |
       Supplier
     Integrations
````

---

# 3. Applications

The target application architecture contains multiple independently deployable applications.

```text
apps/
├── web/
│   └── Public website
│
├── agent/
│   └── B2B agent portal
│
├── admin/
│   └── Admin & operations portal
│
├── supplier/
│   └── Supplier extranet
│
└── api/
    └── Shared backend API
```

Target domains:

```text
www.yourbedbank.com
agent.yourbedbank.com
admin.yourbedbank.com
supplier.yourbedbank.com
api.yourbedbank.com
```

---

# 4. Core Business Domains

FBEDS is organized around the following business domains.

```text
Identity & Access
├── Users
├── Tenants
├── Roles
└── Permissions

Hotel Management
├── Hotels
├── Destinations
├── Room Types
├── Amenities
└── Images

Supplier Management
├── Suppliers
├── Supplier Users
├── Supplier Contracts
├── Supplier Connections
└── Supplier Integrations

Contracting
├── Hotel Contracts
├── Room Contracts
├── Rate Plans
├── Supplements
├── Restrictions
└── Policies

Inventory
├── Availability
├── Allotment
├── Stop Sale
├── Release Period
└── Inventory Rules

Pricing
├── Cost Rates
├── Markups
├── Taxes
├── Commissions
├── Supplements
└── Selling Rates

Search
├── Hotel Search
├── Availability
├── Pricing
├── Cancellation Policies
└── Search Results

Booking
├── Quotes
├── Reservations
├── Booking Items
├── Supplier Confirmation
├── Vouchers
└── Booking Status

Cancellation
├── Cancellation Policies
├── Cancellation Requests
├── Cancellation Charges
└── Refunds

Finance
├── Wallet
├── Credit Limit
├── Payments
├── Refunds
├── Commissions
└── Ledger

Distribution
├── REST APIs
├── XML APIs
├── Supplier APIs
├── Agent APIs
└── Webhooks

Operations
├── Admin
├── MIS
├── Reports
├── Audit Logs
└── Notifications
```

---

# 5. Target Repository Structure

The repository is progressively moving toward the following enterprise structure:

```text
bedbanks-system/
│
├── apps/
│   ├── web/
│   ├── agent/
│   ├── admin/
│   ├── supplier/
│   └── api/
│
├── packages/
│   ├── ui/
│   ├── auth/
│   ├── types/
│   ├── validation/
│   ├── config/
│   └── eslint-config/
│
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── infra/
│   ├── aws/
│   └── docker/
│
├── .github/
│   ├── workflows/
│   ├── CODEOWNERS
│   └── pull_request_template.md
│
├── .env.example
├── .gitignore
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.json
└── README.md
```

The actual repository structure may differ during development. Changes should be made incrementally rather than performing unnecessary rewrites.

---

# 6. Technology Stack

## Frontend

* Next.js
* React
* TypeScript
* Tailwind CSS
* Shared component system

## Backend

* Node.js
* TypeScript
* REST API
* Domain/service architecture
* Zod validation
* Prisma ORM

## Database

Target production database:

```text
AWS Aurora PostgreSQL
```

Aurora PostgreSQL is the system of record.

The frontend must never connect directly to PostgreSQL.

Correct:

```text
Browser
   ↓
Backend API
   ↓
Prisma
   ↓
Aurora PostgreSQL
```

Incorrect:

```text
Browser
   ↓
Aurora PostgreSQL
```

---

# 7. Supporting Infrastructure

Target AWS infrastructure:

| Component                 | Purpose              |
| ------------------------- | -------------------- |
| Aurora PostgreSQL         | Primary database     |
| ECS/Fargate               | Backend API          |
| Application Load Balancer | API routing          |
| ECR                       | Container registry   |
| Amplify                   | Next.js applications |
| Cognito                   | Authentication       |
| Redis                     | Caching              |
| SQS                       | Background jobs      |
| S3                        | Files/assets         |
| Secrets Manager           | Secrets              |
| CloudWatch                | Logs/metrics         |
| WAF                       | Web/API protection   |
| CloudFront                | CDN                  |
| IAM                       | Access control       |

---

# 8. Authentication

Authentication is intended to use AWS Cognito or an equivalent enterprise identity layer.

Authentication flow:

```text
User
 ↓
Login
 ↓
Cognito
 ↓
JWT
 ↓
Backend API
 ↓
Authentication Middleware
 ↓
User / Tenant Context
 ↓
Authorization
```

Authentication and authorization are separate concerns.

Authentication answers:

> Who are you?

Authorization answers:

> What are you allowed to do?

---

# 9. Role-Based Access Control

Potential platform roles include:

```text
SUPER_ADMIN
ADMIN
OPERATIONS
FINANCE
CONTRACTING
RESERVATION_AGENT
REPORTING_USER

SUPPLIER_ADMIN
SUPPLIER_USER

AGENCY_ADMIN
AGENCY_USER
```

Actual roles must be defined by the application's authorization model.

Permissions should be enforced on the backend.

Frontend visibility is not a security boundary.

---

# 10. Multi-Tenancy

FBEDS is designed as a multi-tenant B2B platform.

Potential tenants include:

```text
Travel Agency A
Travel Agency B
Tour Operator C
DMC D
Supplier E
```

Tenant isolation is a critical security requirement.

The authoritative tenant must be derived from the authenticated user/session context.

Never trust:

```text
request.body.tenantId
```

as the security authority.

Preferred:

```text
Authenticated User
       ↓
Identity / JWT
       ↓
Tenant Context
       ↓
Authorization
       ↓
Database Query
```

A tenant must never be able to access another tenant's:

* users
* hotels
* bookings
* rates
* contracts
* wallet
* credit
* financial records
* reports
* customer data

---

# 11. Financial Architecture

Financial functionality is business-critical.

The platform may support:

```text
Wallet
Credit Limit
Deposit
Payment
Refund
Commission
Markup
Supplier Cost
Selling Price
Ledger
```

Financial calculations must not rely on unsafe floating-point arithmetic.

Money should use an appropriate precise representation such as:

* integer minor units, where appropriate
* PostgreSQL Decimal / Prisma Decimal

Financial transactions must support:

* atomicity
* idempotency
* auditability
* concurrency protection
* immutable ledger records where appropriate

---

# 12. Booking Architecture

Booking is a mission-critical domain.

Conceptual lifecycle:

```text
SEARCH
   ↓
QUOTE
   ↓
BOOKING REQUEST
   ↓
PRICE VALIDATION
   ↓
SUPPLIER CONFIRMATION
   ↓
PAYMENT / WALLET
   ↓
CONFIRMED
   ↓
VOUCHER
```

Failure scenarios must be handled explicitly:

```text
Supplier Timeout
Supplier Rejection
Price Change
Inventory Unavailable
Payment Failure
Duplicate Request
Network Failure
Partial Failure
Cancellation
Refund
```

Booking creation should support idempotency to prevent duplicate reservations.

---

# 13. Supplier Integration Architecture

Supplier integrations should use an adapter-based architecture.

Preferred:

```text
                    FBEDS
                      |
             Supplier Interface
                      |
        +-------------+-------------+
        |             |             |
   Supplier A    Supplier B    Supplier C
      Adapter       Adapter       Adapter
```

Each supplier adapter should normalize supplier-specific responses into FBEDS internal models.

Supplier integrations may include:

* REST
* XML
* SOAP
* static inventory
* dynamic availability
* booking APIs
* cancellation APIs
* webhooks

Supplier credentials must never be hard-coded into source code.

---

# 14. Search Architecture

Hotel search may combine:

```text
FBEDS Contracted Inventory
        +
Supplier APIs
        +
Cached Availability
        +
Pricing Engine
        ↓
Normalized Search Results
        ↓
Agent Portal
```

Search should support:

* destination
* check-in
* check-out
* rooms
* adults
* children
* child ages
* nationality
* residency
* meal plan
* availability
* price
* cancellation policy

Performance-critical search data may use Redis caching.

---

# 15. Pricing Architecture

Conceptual pricing:

```text
Supplier Cost
      +
Supplements
      +
Taxes
      +
Markup
      -
Commission
      ↓
Selling Price
```

The exact pricing formula is domain-specific and must be implemented through tested business rules.

Pricing must preserve:

* supplier cost
* currency
* markup
* taxes
* commissions
* final selling price
* applicable cancellation conditions

The price displayed to an agent should be traceable to the pricing calculation used at the time of quotation/booking.

---

# 16. Environment Strategy

FBEDS should maintain separate environments:

```text
Development
     ↓
Staging
     ↓
Production
```

Git workflow:

```text
feature/*
     ↓
develop
     ↓
staging
     ↓
main
     ↓
production
```

Production resources must not be casually used for development.

---

# 17. Git Branching Strategy

### Feature

```bash
git checkout develop
git checkout -b feature/hotel-search
```

### Bug Fix

```bash
git checkout develop
git checkout -b fix/search-pagination
```

### Hotfix

```bash
git checkout main
git checkout -b hotfix/critical-booking-error
```

All production changes should go through Pull Requests.

---

# 18. Development Workflow

Recommended development lifecycle:

```text
Business Requirement
        ↓
GitHub Issue
        ↓
Technical Design
        ↓
Feature Branch
        ↓
AI-assisted Development
        ↓
Unit Tests
        ↓
Integration Tests
        ↓
Pull Request
        ↓
CI
        ↓
Code Review
        ↓
Develop
        ↓
Staging
        ↓
UAT
        ↓
Production
```

---

# 19. AI-Assisted Development

This repository may use:

* v0
* GitHub Copilot
* Cursor
* Codex
* Claude Code
* other AI development tools

AI tools are development assistants, not the final authority.

The repository remains the source of truth.

AI-generated code must be:

* reviewed
* tested
* security checked
* type checked
* linted
* validated against business requirements

---

# 20. v0 Development

This repository is connected to a v0 project.

Continue development through:

[Continue working on v0 →](https://v0.app/chat/projects/prj_lVuB0DvJ2R8OAAEmtT1CqOi02eAI)

v0 is primarily useful for:

* UI
* UX
* React components
* layouts
* dashboards
* forms
* responsive interfaces
* frontend prototypes

v0 should not be treated as the authoritative source for:

* financial business rules
* database architecture
* security architecture
* production infrastructure
* tenant isolation
* booking transaction logic

---

# 21. GitHub Copilot

Copilot should primarily be used for repository-level engineering.

Recommended workflow:

```text
GitHub Issue
     ↓
Copilot
     ↓
Inspect repository
     ↓
Create implementation plan
     ↓
Implement small change
     ↓
Run tests
     ↓
Fix errors
     ↓
Pull Request
     ↓
Human review
```

Copilot should NOT be instructed to blindly rebuild the entire platform.

Critical domains require human review:

* authentication
* authorization
* multi-tenancy
* booking
* payments
* wallet
* ledger
* refunds
* supplier booking
* production infrastructure

---

# 22. Testing

Testing is mandatory for production-critical functionality.

Target testing layers:

```text
Unit Tests
     ↓
Integration Tests
     ↓
API Tests
     ↓
E2E Tests
     ↓
Staging/UAT
```

Critical flows:

```text
Authentication
Tenant Isolation
Hotel Search
Pricing
Booking
Cancellation
Wallet
Payment
Refund
Supplier Failure
```

Booking and financial functionality should have automated regression tests.

---

# 23. CI/CD

GitHub Actions should eventually validate:

```text
Install
 ↓
Lint
 ↓
Typecheck
 ↓
Prisma Validate
 ↓
Prisma Generate
 ↓
Unit Tests
 ↓
Integration Tests
 ↓
Build
 ↓
Security Scan
```

Deployment:

```text
develop → staging

main → production
```

Production deployment should include appropriate approvals and rollback procedures.

AWS deployment should preferably use short-lived GitHub OIDC credentials rather than long-lived AWS access keys.

---

# 24. Secrets Management

Never commit:

```text
.env
.env.local
.env.production
AWS credentials
database passwords
supplier passwords
API secrets
private keys
payment credentials
```

Runtime production secrets should be stored in AWS Secrets Manager or another approved enterprise secrets manager.

Never print secret values in logs or AI audit reports.

---

# 25. Security Principles

FBEDS follows these principles:

### Least Privilege

Users and services receive only the permissions required.

### Zero Trust

Never trust client-provided security context.

### Server-Side Authorization

Authorization must be enforced by the backend.

### Tenant Isolation

Every tenant-owned resource must be properly isolated.

### Secret Protection

Secrets never belong in source control.

### Defense in Depth

Authentication, authorization, validation, database constraints, logging and monitoring should work together.

---

# 26. Database Rules

The database is the system of record.

Important rules:

1. Do not expose Aurora directly to browsers.
2. Do not bypass the backend authorization layer.
3. Do not run destructive production migrations casually.
4. Every schema change must be reviewed.
5. Financial tables require additional scrutiny.
6. Critical booking operations require transaction analysis.
7. Indexes should be designed around real query patterns.
8. Foreign keys and constraints should protect data integrity.

---

# 27. Performance Principles

Potential high-load areas include:

* hotel search
* supplier aggregation
* availability
* pricing
* booking
* reporting

Performance tools may include:

```text
Redis
SQS
Database indexes
Pagination
Connection pooling
Caching
Async processing
Supplier timeout controls
Horizontal scaling
```

Performance optimization should be based on measurements rather than assumptions.

---

# 28. Observability

Production systems should provide:

* structured logs
* request IDs
* correlation IDs
* health checks
* error monitoring
* metrics
* alerts
* audit logs

Important business metrics include:

```text
Search latency
Booking success rate
Booking failure rate
Supplier failure rate
API 5xx rate
Wallet failures
Payment failures
Database latency
Queue failures
```

---

# 29. Production Readiness

FBEDS must not be considered production-ready simply because:

* the UI works
* the application builds
* login works
* hotel search works

Production readiness requires validation of:

```text
Security
Multi-tenancy
Database integrity
Booking integrity
Financial integrity
Supplier reliability
Testing
CI/CD
Backups
Monitoring
Logging
Performance
Rollback
Disaster recovery
```

---

# 30. Definition of Done

A feature is considered complete only when:

* business requirements are implemented
* code is type-safe
* validation exists
* authorization exists where required
* tenant isolation is verified
* tests exist
* lint passes
* typecheck passes
* build passes
* CI passes
* documentation is updated where necessary
* staging is tested
* acceptance criteria are met

---

# 31. Priority Classification

## P0 — Critical

Must be fixed before production.

Examples:

* cross-tenant data access
* authentication bypass
* financial corruption
* duplicate bookings
* exposed production credentials
* destructive data-loss risk
* critical authorization failure

## P1 — High

Must be addressed before serious production scale.

Examples:

* weak booking architecture
* missing transaction boundaries
* unreliable supplier integration
* major database performance issues
* missing production monitoring

## P2 — Medium

Important improvements and technical debt.

Examples:

* refactoring
* optimization
* documentation
* developer experience
* non-critical UX improvements

## P3 — Low

Nice-to-have improvements.

---

# 32. Current Development Status

This repository is under active development.

The platform should currently be treated as:

```text
MVP / Development
        ↓
Architecture Hardening
        ↓
Staging
        ↓
Production
```

Do not assume that every target enterprise component described in this README is already implemented.

For the current implementation, inspect the actual source code.

---

# 33. Getting Started

Install dependencies:

```bash
npm install
```

or:

```bash
pnpm install
```

Start development:

```bash
npm run dev
```

or:

```bash
pnpm dev
```

Open:

```text
http://localhost:3000
```

---

# 34. Environment Variables

Create a local environment file based on:

```text
.env.example
```

Never commit actual environment secrets.

Example categories may include:

```text
DATABASE_URL
NEXT_PUBLIC_API_URL
AUTH configuration
AWS configuration
REDIS configuration
S3 configuration
SUPPLIER API configuration
```

Actual required variables must be documented by the application.

---

# 35. Useful Commands

Typical development commands:

```bash
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

For Prisma projects:

```bash
pnpm prisma validate
pnpm prisma generate
```

Do not execute production migrations without following the approved deployment process.

---

# 36. Pull Request Requirements

Every Pull Request should explain:

### What changed?

Describe the implementation.

### Why?

Reference the business requirement or GitHub Issue.

### Database changes?

Explain schema/migration changes.

### Security impact?

Explain authentication, authorization and tenant implications.

### Testing?

List tests executed.

### Deployment impact?

Explain environment or infrastructure changes.

### Rollback?

Explain how the change can be safely reverted.

---

# 37. Code Review Checklist

Before merging, review:

```text
[ ] Business requirement satisfied
[ ] No unnecessary rewrite
[ ] TypeScript passes
[ ] Lint passes
[ ] Tests pass
[ ] Authentication checked
[ ] Authorization checked
[ ] Tenant isolation checked
[ ] Database queries reviewed
[ ] Transactions reviewed
[ ] Financial calculations reviewed
[ ] Secrets protected
[ ] Error handling implemented
[ ] Logging appropriate
[ ] Performance considered
[ ] Documentation updated
```

---

# 38. Important Engineering Rule

Do not optimize for the number of screens or lines of AI-generated code.

Optimize for:

```text
Correctness
Security
Reliability
Testability
Scalability
Maintainability
Business Integrity
```

A smaller reliable bedbank is better than a large unstable platform.

---

# 39. Roadmap

The expected engineering sequence is:

```text
PHASE 0
Repository Audit & Stabilization

PHASE 1
Architecture + Security Foundation

PHASE 2
Authentication + RBAC + Multi-Tenancy

PHASE 3
Database + Hotel Master

PHASE 4
Supplier + Contracting

PHASE 5
Rates + Availability + Pricing

PHASE 6
Search Engine

PHASE 7
Quotation Engine

PHASE 8
Booking + Cancellation

PHASE 9
Wallet + Credit + Ledger

PHASE 10
Agent Portal

PHASE 11
Supplier Extranet

PHASE 12
Admin & Operations

PHASE 13
Supplier API/XML Integrations

PHASE 14
Testing + Performance

PHASE 15
AWS Production Hardening

PHASE 16
Production Launch
```

---

# 40. Repository Governance

The following are considered protected engineering areas:

```text
Authentication
Authorization
Multi-tenancy
Database schema
Financial ledger
Wallet
Payments
Booking
Supplier booking
Production infrastructure
CI/CD
Secrets
```

Changes to these areas require additional review and testing.

---

# 41. Source of Truth

The authoritative source of the FBEDS platform is:

```text
GitHub Repository
      +
Approved Database Schema
      +
Infrastructure Configuration
      +
Business Requirements
      +
Automated Tests
```

AI-generated suggestions, v0 prototypes, chat conversations and generated code are not independently authoritative until reviewed and committed to the repository.

---

# 42. License

Proprietary / Private Commercial Software.

Copyright © FBEDS.

Unauthorized copying, distribution, reverse engineering or commercial use is prohibited unless explicitly authorized by the rights holder.

---

# 43. Project Links

### v0

[Continue working on the FBEDS v0 project →](https://v0.app/chat/projects/prj_lVuB0DvJ2R8OAAEmtT1CqOi02eAI)

### Next.js

[https://nextjs.org/docs](https://nextjs.org/docs)

### Prisma

[https://www.prisma.io/docs](https://www.prisma.io/docs)

### AWS

[https://aws.amazon.com/](https://aws.amazon.com/)

### GitHub

[https://github.com/](https://github.com/)

---

# 44. CTO Principle

> **Build FBEDS as a financial and transaction-critical enterprise platform, not simply as a hotel booking website.**

Every major feature should answer five questions:

1. Is it secure?
2. Is tenant data isolated?
3. Is the database consistent?
4. Can the transaction recover from failure?
5. Can we test and operate it in production?

If the answer is not clear, the feature is not production-ready.

---

## FBEDS

**Enterprise B2B Hotel Distribution Infrastructure**

```text
Contract → Inventory → Rate → Search → Quote → Book → Voucher → Cancel → Refund → Ledger
```

**Build deliberately. Test continuously. Secure by design.**

```

Refine the repository documentation

- :contentReference[oaicite:0]{index=0}
```
