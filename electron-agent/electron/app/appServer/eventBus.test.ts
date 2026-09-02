import { describe, expect, it, vi } from 'vitest';
import type { AppEvent } from './types';
import { EventBus } from './eventBus';

function event(id: string): Omit<AppEvent, 'sequence'> {
  return {
    id,
    type: 'item.created',
    timestamp: 1,
    data: { id },
  };
}

describe('EventBus', () => {
  it('rejects zero and fractional capacities', () => {
    expect(() => new EventBus(0)).toThrow('EventBus capacity must be a positive integer');
    expect(() => new EventBus(1.5)).toThrow('EventBus capacity must be a positive integer');
  });

  it('rejects invalid replay sequence values', () => {
    const bus = new EventBus();

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      expect(() => bus.replay(value)).toThrow('afterSequence must be a finite non-negative number');
    }
  });

  it('supports unsubscribing a subscriber', () => {
    const bus = new EventBus();
    const received: AppEvent[] = [];
    const unsubscribe = bus.subscribe((value) => received.push(value));

    bus.publish(event('a'));
    unsubscribe();
    bus.publish(event('b'));

    expect(received.map((value) => value.id)).toEqual(['a']);
  });

  it('retains exactly one event at capacity one', () => {
    const bus = new EventBus(1);
    bus.publish(event('a'));
    bus.publish(event('b'));

    expect(bus.replay(1)).toEqual({
      kind: 'events',
      events: [expect.objectContaining({ id: 'b', sequence: 2 })],
    });
  });

  it('assigns monotonically increasing sequences when publishing', () => {
    const bus = new EventBus();

    expect(bus.publish(event('a')).sequence).toBe(1);
    expect(bus.publish(event('b')).sequence).toBe(2);
  });

  it('isolates subscriber errors from other subscribers', () => {
    const bus = new EventBus();
    const failing = vi.fn(() => {
      throw new Error('subscriber failed');
    });
    const received: AppEvent[] = [];
    bus.subscribe(failing);
    bus.subscribe((value) => received.push(value));

    bus.publish(event('a'));

    expect(failing).toHaveBeenCalledOnce();
    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe('a');
  });

  it('returns a gap when replay starts before the retained buffer', () => {
    const bus = new EventBus(2);
    bus.publish(event('a'));
    bus.publish(event('b'));
    bus.publish(event('c'));

    expect(bus.replay(0)).toMatchObject({ kind: 'gap' });
    expect(bus.replay(1)).toMatchObject({
      kind: 'events',
      events: [expect.objectContaining({ id: 'b', sequence: 2 }), expect.objectContaining({ id: 'c', sequence: 3 })],
    });
  });

  it('returns an empty event list when replay starts at the latest sequence', () => {
    const bus = new EventBus(2);
    const latest = bus.publish(event('a')).sequence;

    expect(bus.replay(latest)).toEqual({ kind: 'events', events: [] });
  });
});
