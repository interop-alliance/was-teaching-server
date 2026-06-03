/**
 * Helper: true if a content-type denotes JSON (application/json or any
 * application/*+json variant).
 * @param options {object}
 * @param options.contentType {string}
 * @returns {boolean}
 */
export function isJson({ contentType }: { contentType?: string }): boolean {
  return (
    typeof contentType === 'string' &&
    Boolean(contentType.match(/application\/[^+]*[+]?(json);?.*/))
  )
}
