// Directive comments in the positions StrykerJS reads and in the ones it does not.
export function plain(a: number, b: number) {
  return a > b ? a - b : b + a;
}

// Stryker disable all
export function disabled(a: number, b: number) {
  if (a >= b) return [a, b];
  return { sum: a + b, text: 'total' };
}
// Stryker restore all

export function restored(a: number) {
  return a > 0 && a < 10;
}

export function nextLine(a: number, b: number) {
  // Stryker disable next-line all: boundary is covered by the property test
  const inside = a >= 0 && a <= b;
  const outside = a < 0 || a > b;
  // Stryker disable next-line EqualityOperator
  const equal = a >= b ? 'ge' : 'lt';
  // Stryker disable next-line StringLiteral, ConditionalExpression: display only
  const label = a === b ? 'same' : 'different';
  return [inside, outside, equal, label];
}

export function byMutator(items: number[]) {
  // Stryker disable ArithmeticOperator,BlockStatement: sizes are checked elsewhere
  let total = 0;
  for (const item of items) {
    total = total + item * 2;
  }
  // Stryker restore ArithmeticOperator
  const mean = total / items.length;
  if (mean > 3) {
    return mean - 1;
  }
  // Stryker restore all
  return mean + 1;
}

export function positions(a: number, b: number) {
  const first = a > b; // Stryker disable next-line all
  const second = a < b;
  const third = a + b * 2;
  /* Stryker disable next-line all */ const fourth = a - b;
  const fifth = a * b;
  if (a > 1) {
    b = b + 1;
    // Stryker disable all: a comment before a closing brace leads no node
  }
  const sixth = a % b;
  return [first, second, third, fourth, fifth, sixth];
}

export const arrow = (a: number) =>
  // Stryker disable next-line all
  a > 1
    ? 'big'
    : 'small';

export class Shape {
  // Stryker disable next-line all
  size = 1 + 1;
  // Stryker disable all
  area() { return this.size * this.size; }
  // Stryker restore all
  scale(by: number) { this.size = this.size * by; return this; }
}

export function calls(log: (text: string) => void, a: number) {
  // Stryker disable next-line CallExpression
  log('removed');
  // Stryker disable next-line StringLiteral
  log('kept');
  log(
    // Stryker disable next-line all
    a > 1 ? 'x' : 'y');
  // Stryker disable next-line all
  if (a > 2) { log('late'); }
  // Stryker restore next-line all
  return a + 1;
}
// Stryker disable all: not a real mutator name list follows
// Stryker disable Nonsense
export const tail = (a: number) => a + 1;
