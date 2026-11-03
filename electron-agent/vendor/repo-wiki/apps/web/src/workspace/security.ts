import DOMPurify from "dompurify";
/** SVG is inert markup only: no executable/embedded or remote resources. */
export function sanitizeDiagramSvg(svg: string): string {
  const safe = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      "foreignObject",
      "script",
      "image",
      "iframe",
      "object",
      "embed",
      "a",
    ],
    FORBID_ATTR: ["onclick", "onload", "onerror"],
  });
  const document = new DOMParser().parseFromString(safe, "image/svg+xml");
  if (document.querySelector("parsererror")) return "";
  for (const element of Array.from(document.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      if (
        (attribute.localName === "href" || attribute.name === "xlink:href") &&
        !attribute.value.startsWith("#")
      )
        element.removeAttributeNode(attribute);
      if (/url\s*\(/i.test(attribute.value))
        element.setAttribute(attribute.name, stripRemoteCss(attribute.value));
    }
    if (element.localName === "style")
      element.textContent = stripRemoteCss(element.textContent || "");
  }
  return new XMLSerializer().serializeToString(document.documentElement);
}
function stripRemoteCss(value: string): string {
  return value
    .replace(/@import[^;]*(;|$)/gi, "")
    .replace(/url\(([^)]*)\)/gi, (full, uri: string) =>
      uri
        .trim()
        .replace(/^['"]|['"]$/g, "")
        .startsWith("#")
        ? full
        : "none",
    );
}
export function diagramIsSafeInput(code: string): boolean {
  // Untrusted text may not override renderer configuration or inject theme CSS.
  return !/%%\s*\{|^\s*---\s*\n|@import|https?:\/\//im.test(code);
}
