import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The /api/v1 proxy lives in proxy.ts and reads API_INTERNAL_URL per request (ADR 0055), so nothing about the API origin is baked at build time.

// Container images (Dockerfile.web) build a self-contained server; Vercel and local builds are unchanged.
const standalone = process.env.NEXT_OUTPUT === 'standalone'

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(standalone ? { output: 'standalone', outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..') } : {}),
  images: {
    unoptimized: true,
  },
  transpilePackages: ['@bedbanks/ui', '@bedbanks/contracts'],
}

export default nextConfig

