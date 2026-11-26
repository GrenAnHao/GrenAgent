import {expect, it} from 'vitest';
import {placeTrendTip, weekdayOf} from './trendInspection';
it('centres or clamps the bubble and clears every bar under its footprint', () => {
  const box={left:0,right:400}, bar={left:190,right:210,top:150};
  expect(placeTrendTip(box,bar,100,[{left:154,right:162,top:50},{left:80,right:90,top:0}]))
    .toEqual({left:150,bottom:40,anchor:50,stem:110});
  expect(placeTrendTip(box,{left:4,right:16,top:35},100,[]).left).toBe(0);
  expect(placeTrendTip(box,{left:380,right:398,top:40},100,[]).left).toBe(300);
  expect(weekdayOf('2026-10-16')).toBe('周五');
});
