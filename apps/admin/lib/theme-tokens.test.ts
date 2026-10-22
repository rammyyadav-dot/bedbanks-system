import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { contrastRatio, darkVariant, normalizeHex, parseHex } from './theme/color'
import { TOKENS_FILE, parseLightTokens, parseThemePreference, renderTokensCss } from './theme/tokens'

const root = join(import.meta.dirname, '..')
const tokensCss = readFileSync(join(root, TOKENS_FILE), 'utf8')

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.(tsx|css)$/.test(entry) && !path.endsWith('theme-tokens.css')) out.push(path)
  }
  return out
}
const files = [...sources(join(root, 'app')), ...sources(join(root, 'components'))]

test('the committed token file is exactly what the generator produces from its light block', () => {
  assert.equal(renderTokensCss(parseLightTokens(tokensCss)), tokensCss, 'run pnpm theme:tokens')
})

test('no raw colour literals outside the token file: every colour goes through a theme token', () => {
  const offenders = files.flatMap((file) => readFileSync(file, 'utf8').split('\n')
    .map((line, i) => ({ file, line: i + 1, hit: /(?<![\w&#"'-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b(?![-\w])/.exec(line)?.[0] }))
    .filter((o) => o.hit && !/href=|url\(#/.test(o.hit)))
  assert.deepEqual(offenders.slice(0, 5), [], 'use var(--c-…) tokens (see app/theme-tokens.css)')
})

test('every referenced token is defined', () => {
  const defined = new Set(Object.keys(parseLightTokens(tokensCss)))
  const missing = new Set<string>()
  for (const file of files) for (const m of readFileSync(file, 'utf8').matchAll(/var\((--[ck]-[^)]*)\)/g)) if (!defined.has(m[1]!)) missing.add(`${m[1]} (${file.slice(root.length)})`)
  assert.deepEqual([...missing], [])
})

test('dark variant keeps pairs readable: reflected lightness, kept hue, scrims and shadows untouched', () => {
  const surface = parseHex(darkVariant('#ffffff'))
  const text = parseHex(darkVariant('#1a1a1a'))
  assert.ok(contrastRatio(text, surface) >= 7, 'body text on a page surface stays high-contrast')
  for (const [fg, bg] of [['#4a4a4a', '#ffffff'], ['#35545e', '#f3f7f9'], ['#8a5a00', '#fff4dc'], ['#0b6b55', '#e6f7f2'], ['#a11d1d', '#fde8e8']] as const) {
    const before = contrastRatio(parseHex(fg), parseHex(bg))
    const after = contrastRatio(parseHex(darkVariant(fg)), parseHex(darkVariant(bg)))
    assert.ok(after >= Math.min(4.5, before * 0.8), `${fg} on ${bg}: ${before.toFixed(1)} -> ${after.toFixed(1)}`)
  }
  assert.equal(darkVariant('#08252b66'), '#08252b66', 'a translucent dark colour is a scrim and does not invert')
  assert.equal(normalizeHex('#FFF'), '#ffffff')
})

test('light theme is unchanged: the light block holds the original colours; dark-chrome tokens are identical in both themes', () => {
  const light = parseLightTokens(tokensCss)
  assert.equal(light['--c-ffffff'], '#ffffff')
  assert.equal(light['--k-0d2631'], '#0d2631', 'the sidebar keeps its colour')
  const darkBlock = tokensCss.slice(tokensCss.indexOf(":root[data-theme='dark']"))
  assert.doesNotMatch(darkBlock, /--k-/, 'identity tokens are never redefined for dark')
  assert.match(tokensCss, /prefers-color-scheme: dark\) \{\s*:root\[data-theme='system'\]/)
})

test('theme preference parsing falls back to light for unknown cookie values', () => {
  assert.equal(parseThemePreference('dark'), 'dark')
  assert.equal(parseThemePreference('system'), 'system')
  assert.equal(parseThemePreference('<script>'), 'light')
  assert.equal(parseThemePreference(undefined), 'light')
})

test('theme switching: server renders data-theme from the cookie, the toggle persists a plain preference', () => {
  const layout = readFileSync(join(root, 'app', 'layout.tsx'), 'utf8')
  assert.match(layout, /parseThemePreference\(\(await cookies\(\)\)\.get\(THEME_COOKIE\)\?\.value\)/)
  assert.match(layout, /<html lang="en" data-theme=\{theme\}>/)
  assert.doesNotMatch(layout, /dangerouslySetInnerHTML/, 'no inline script: the first paint is themed by the server')
  const toggle = readFileSync(join(root, 'components', 'layout', 'ThemeToggle.tsx'), 'utf8')
  assert.match(toggle, /aria-pressed/)
  assert.match(toggle, /THEME_PREFERENCES\.map/)
  assert.doesNotMatch(toggle, /fbeds_session|tenant|localStorage/, 'a display preference only')
  for (const file of ['Topbar.tsx', 'HotelAdminHeader.tsx']) assert.match(readFileSync(join(root, 'components', 'layout', file), 'utf8'), /<ThemeToggle \/>/, `${file} offers the toggle`)
})

test('dark chrome stays dark: the sidebar, user menu and hotel header use identity tokens, not inverted ones', () => {
  const css = (f: string) => readFileSync(join(root, f), 'utf8')
  assert.match(css('components/layout/shell-theme.css'), /--shell-menu-bg: var\(--k-/)
  const header = css('components/layout/hotel-admin.css').split('\n').find((l) => l.startsWith('.hotel-admin-header {')) ?? ''
  assert.match(header, /background: var\(--k-2563eb\)/)
  assert.match(css('app/globals.css'), /\.enterprise-sidebar \{[^}]*var\(--k-/)
})
