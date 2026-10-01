/**
 * Legal approval gate for the public privacy notice. Engineering review is not legal
 * approval: keep this false until the privacy owner signs off the final text in
 * docs/website-privacy-review.md, then set it to true in the same PR that publishes the
 * approved wording. While false the page is excluded from the sitemap and from indexing.
 */
export const privacyPolicyApproved = false
