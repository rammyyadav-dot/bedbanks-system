type UrlApi = {
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
}

/** Opens booking HTML from a blob URL and revokes the previous one. The caller revokes the last URL on unmount. */
export function replaceDocumentUrl(registry: { current: string | null }, html: string, urls: UrlApi = URL): string {
  if (registry.current) urls.revokeObjectURL(registry.current)
  const url = urls.createObjectURL(new Blob([html], { type: 'text/html' }))
  registry.current = url
  return url
}

export function revokeDocumentUrl(registry: { current: string | null }, urls: UrlApi = URL): void {
  if (!registry.current) return
  urls.revokeObjectURL(registry.current)
  registry.current = null
}
