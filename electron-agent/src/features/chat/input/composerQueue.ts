import type { UserImage } from '../../../stores/agentReducer';

export type ComposerQueuedItem = {
  id: string;
  text: string;
  images?: UserImage[];
};

let seq = 0;

export function createComposerItem(text: string, images?: UserImage[]): ComposerQueuedItem {
  return { id: `cq-${++seq}`, text, ...(images?.length ? { images } : {}) };
}

export function removeComposerItem(queue: ComposerQueuedItem[], id: string): ComposerQueuedItem[] {
  return queue.filter((item) => item.id !== id);
}

export function updateComposerItem(queue: ComposerQueuedItem[], id: string, text: string): ComposerQueuedItem[] {
  return queue.map((item) => (item.id === id ? { ...item, text } : item));
}
