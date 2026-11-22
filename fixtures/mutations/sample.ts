'use strict';
import { helper } from './helper';

declare const ambient: string;
type Shape = { kind: 'circle' | 'square'; size: number };
interface Named { name: string }
enum Level { Low = 1 + 1, High = Low * 2 }

export const limits = { min: 0, max: 100, labels: ['low', 'high'], empty: [], none: {} };
export const pattern = /^\d+[a-z]*(?=x)$/i;
export const built = new RegExp('^a+\\s[^b]$', 'g');
export const list = new Array(3);
export const nothing = Array();

export function classify(value: number, shape: Shape, names: string[]): string {
  'use strict';
  let total = value * 2 + limits.min;
  total += shape.size;
  total -= -1;
  if (value >= limits.max && shape.kind === 'circle' || !names.length) {
    return `big ${shape.kind}`;
  }
  for (let i = 0; i < names.length; i++) {
    total = total % 7 === 0 ? total / 7 : total - i;
  }
  for (;;) {
    break;
  }
  while (total > 1000) total--;
  do { ++total; } while (false);
  switch (shape.kind) {
    case 'circle':
      helper(total);
      break;
    case 'square':
    default:
      total = ~total;
  }
  const picked = names.filter(name => name.trim().length > 0).map(name => name.toUpperCase());
  const first = picked[0]?.charAt(0) ?? '';
  const safe = names?.[0]?.startsWith('a') ? Math.min(total, 1) : Math.max(total, 2);
  const tagged = String.raw`raw ${total}`;
  const label = 'value: ' + total + first;
  const numeric = +label.length;
  names.sort();
  names.reverse().slice(1);
  delete (limits as { extra?: number }).extra;
  if (safe) throw new Error(tagged + numeric);
  return label satisfies string;
}

export class Counter<T extends Named> {
  static created = 0;
  private items: T[] = [];
  #secret = 'hidden';
  constructor(public readonly label: string, private step = 1) {
    Counter.created++;
  }
  add(item: T): this {
    this.items.push(item);
    this.step ||= 2;
    this.step &&= 3;
    this.step ??= 4;
    this.step <<= 1;
    return this;
  }
  get size(): number {
    return this.items.length * this.step;
  }
  names = (): string[] => this.items.map(item => item.name);
  ['computed' + 1]() {
    return [...this.items].every(item => item.name !== this.#secret);
  }
}

export class Derived extends Counter<Named> {
  extra = true;
  constructor() {
    super('derived');
    helper(this.extra);
  }
}

export const arrows = {
  identity: (x: number) => x,
  nothing: () => undefined,
  object: () => ({ a: 1 }),
  block: (x: number) => { return x + 1; },
  async later(x: number) { await helper(x); helper(); },
  'quoted key': 1,
};
const [head, ...rest] = [1, 2, 3];
let swapA = 1, swapB = 2;
[swapA, swapB] = [swapB, swapA];
({ min: swapA } = limits);
export default head + rest.length;
