import { createContext } from 'react';
import type { DisplayMessage } from './groupMessages';

/** Actual rendered conversation, including child transcripts which share the parent's store provider. */
export const MessageTimelineContext = createContext<readonly DisplayMessage[] | null>(null);
