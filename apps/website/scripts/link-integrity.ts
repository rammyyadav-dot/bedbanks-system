import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { footerNavigation, primaryNavigation, publicRoutes } from '../lib/navigation'

export function pageFileForRoute(appRoot: string, route: string) { return join(appRoot, route === '/' ? 'page.tsx' : `${route.slice(1)}/page.tsx`) }
export function findBrokenInternalLinks(appRoot: string, projectRoot: string) {
  const known = new Set<string>(publicRoutes)
  const declared = [...primaryNavigation, ...footerNavigation.company, ...footerNavigation.explore]
  const errors: string[] = []
  for (const item of declared) if (item.href.startsWith('/') && !known.has(item.href as typeof publicRoutes[number])) errors.push(`Navigation points to undeclared route: ${item.href}`)
  for (const route of publicRoutes) if (!existsSync(pageFileForRoute(appRoot, route))) errors.push(`Missing page for public route: ${route}`)
  const walk = (directory: string) => { for (const entry of readdirSync(directory)) { const path = join(directory, entry); if (statSync(path).isDirectory()) walk(path); else if (/\.(tsx|ts)$/.test(entry)) { const source = readFileSync(path, 'utf8'); for (const match of source.matchAll(/href=["'](\/[a-z0-9\-/]*)["']/gi)) { const href = match[1]; if (href && !known.has(href as typeof publicRoutes[number]) && !['/agent', '/supplier', '/admin'].includes(href)) errors.push(`${relative(projectRoot, path)} links to missing route: ${href}`) } } } }
  walk(join(projectRoot, 'app')); walk(join(projectRoot, 'components'))
  return [...new Set(errors)]
}
