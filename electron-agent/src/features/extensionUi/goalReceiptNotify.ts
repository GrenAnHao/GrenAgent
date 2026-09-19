/** Goal 成功回执已由条和 command-input 展示，顶部 toast 不再重复。 */
const GOAL_RECEIPT = /的目标 · .+ · \d+\/\d+ · (armed|disarmed)$/;

export function isGoalReceiptNotify(text: string): boolean {
  return text === '已清除目标。' || GOAL_RECEIPT.test(text);
}
