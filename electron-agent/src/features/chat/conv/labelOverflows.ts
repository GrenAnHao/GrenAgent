export function labelOverflows(node: { scrollWidth: number; clientWidth: number }): boolean {
  return node.scrollWidth > node.clientWidth;
}
