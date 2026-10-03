/**
 * Images are intentionally not offered. The repository has no approved storage mechanism for hotel images (no bucket, signed upload,
 * virus scan or rights model), so an upload button here would be a fake. See ADR 0021 for the dependency.
 */
export function ImagesPanel() {
  return (
    <section className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 8 }} aria-label="Hotel images" data-testid="images-unavailable">
      <h2 style={{ fontSize: 14, margin: 0 }}>Images</h2>
      <p role="status" style={{ margin: 0, fontSize: 13 }}><strong>Image management is not available yet.</strong> No images are shown or stored, and nothing can be uploaded.</p>
      <p style={{ margin: 0, fontSize: 12, color: '#3f565c' }}>Dependency: an approved image storage service. Upload, caption, ordering, cover selection, rights and source records, deletion and recovery need that service, size and type limits, and malware scanning, and they must never fetch an arbitrary URL on the server. Until it exists this tab stays read-only and the directory shows no thumbnails.</p>
    </section>
  )
}
