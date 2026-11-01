# ADR 0011: One deployment path for the public website

## Status
Accepted for code review. Not applied to any remote Vercel project by this change.

## Context
Three overlapping mechanisms could build the website: `apps/website/vercel.json`, a root `vercel.json` using `pnpm vercel-build`, and a script that copied `apps/website/.next` into the repository root (`tools/publish-website-next-output.ts`). A Vercel project with a blank Root Directory silently deployed the website, which is dangerous in a repository that also builds Admin, Agent and Supplier. All three were added within one hour to make a mis-configured project build.

## Decision
The website deploys only from a dedicated Vercel project whose Root Directory is `apps/website`, configured by `apps/website/vercel.json`. Admin, Agent and Supplier are separate projects. The root `vercel.json`, the root `vercel-build` script and `tools/publish-website-next-output.ts` are removed. Consumers were traced by repository-wide search: no workflow, script, document or package referenced them other than each other. Other root scripts and `tools/` utilities are untouched.

## Consequences
- A project that still has a blank Root Directory will no longer build the website. Its build will use Vercel's default detection and most likely fail loudly instead of deploying the wrong app.
- Remote settings must be corrected by the owner. Known mismatch at the time of this change: the Vercel project `bedbanks-system` serves Admin on `fbeds-admin.vercel.app` but its Root Directory was observed as `apps/website`.
- Rollback: restore the three removed files from Git history.
