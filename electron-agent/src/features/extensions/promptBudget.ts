/** UI estimate only: ASCII prose ~4 characters/token, non-ASCII ~1/token. */
export function promptBudget(text: string) {
  let characters = 0, quarters = 0;
  for (const ch of text) { characters++; quarters += ch.charCodeAt(0) < 128 ? 1 : 4; }
  return { characters, tokens: Math.ceil(quarters / 4) };
}

export function manualSkill(skill: { description: string; disableModelInvocation?: boolean }) {
  return skill.disableModelInvocation || /仅(?:在用户)?显式|仅(?:限)?手动|不要根据上下文自动触发|only (?:when (?:the )?user explicitly|when explicitly|on explicit|invoke manually)|do not (?:auto[- ]?trigger|invoke automatically)|manual[- ]only/i.test(skill.description);
}
