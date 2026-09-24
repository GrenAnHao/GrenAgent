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

export function moveComposerItem(
  queue: ComposerQueuedItem[],
  id: string,
  beforeId: string | null,
): ComposerQueuedItem[] {
  const from = queue.findIndex((item) => item.id === id);
  if (from < 0) return queue;
  const next = queue.filter((item) => item.id !== id);
  const to = beforeId == null ? next.length : next.findIndex((item) => item.id === beforeId);
  if (to < 0) return queue;
  const moved = queue[from];
  if (!moved) return queue;
  next.splice(to, 0, moved);
  const same = next.every((item, index) => item === queue[index]);
  return same ? queue : next;
}
