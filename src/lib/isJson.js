/**
 * Helper: true if a content-type denotes JSON (application/json or any
 * application/*+json variant).
 * @param options {object}
 * @param options.contentType {string}
 * @returns {boolean}
 */
export function isJson({ contentType }) {
  return typeof contentType === 'string' &&
    (contentType.match(/application\/[^+]*[+]?(json);?.*/))
}
