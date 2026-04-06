export function isJson({ contentType }) {
  return typeof contentType === 'string' &&
    (contentType.match(/application\/[^+]*[+]?(json);?.*/))
}
