import type { AppEvent } from './types';

export interface EventBusEventInput extends Omit<AppEvent, 'sequence'> {}

export type ReplayResult =
  | { kind: 'events'; events: AppEvent[] }
  | { kind: 'gap'; earliestSequence: number; latestSequence: number };

export type EventSubscriber = (event: AppEvent) => void;

export class EventBus {
  private nextSequence: number;
  private readonly buffer: AppEvent[] = [];
  private readonly subscribers = new Set<EventSubscriber>();

  constructor(private readonly capacity = 256, startSequence = 1) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('EventBus capacity must be a positive integer');
    if (!Number.isInteger(startSequence) || startSequence < 1) throw new Error('EventBus startSequence must be a positive integer');
    this.nextSequence = startSequence;
  }

  publish(input: EventBusEventInput): AppEvent {
    const event: AppEvent = { ...input, sequence: this.nextSequence++ };
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // A subscriber is isolated so one faulty consumer cannot stop delivery.
      }
    }
    return event;
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  replay(afterSequence: number): ReplayResult {
    if (!Number.isFinite(afterSequence) || afterSequence < 0) {
      throw new Error('afterSequence must be a finite non-negative number');
    }
    const earliestSequence = this.buffer[0]?.sequence;
    const latestSequence = this.buffer[this.buffer.length - 1]?.sequence ?? this.nextSequence - 1;
    if (earliestSequence !== undefined && afterSequence < earliestSequence - 1) {
      return { kind: 'gap', earliestSequence, latestSequence };
    }
    return {
      kind: 'events',
      events: this.buffer.filter((event) => event.sequence > afterSequence),
    };
  }
}
