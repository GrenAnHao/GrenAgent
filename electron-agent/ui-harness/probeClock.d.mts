export function installScenarioClock(scenario: string, page?: Window & typeof globalThis): (() => void) | undefined
export function createProbeClock(js: (expression: string) => Promise<number | false | null>): { advanceBy(ms: number): Promise<number> }
