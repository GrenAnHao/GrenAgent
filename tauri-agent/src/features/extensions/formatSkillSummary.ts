export function formatSkillSummary(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}