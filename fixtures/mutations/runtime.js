// A script without imports: the tests evaluate it once with switches and once per plain source edit.
var log = []
var note = function (value) { log.push(String(value)) }
const limits = { min: 0, max: 100, labels: ['low', 'high'], empty: [] }
const digits = /^\d+[a-z]*$/i
const spaced = new RegExp('^a+\\s[^b]$')

function classify(value, kind, names) {
  'use strict'
  let total = value * 2 + limits.min
  total += kind.length
  total -= -1
  if (value >= limits.max && kind === 'circle' || !names.length) {
    return `big ${kind}`
  }
  for (let i = 0; i < names.length; i++) {
    total = total % 7 === 0 ? total / 7 : total - i
  }
  for (;;) {
    break
  }
  let guard = 0
  while (total > 1000 && guard < 50) { total--; guard++ }
  do { ++total } while (false)
  switch (kind) {
    case 'circle':
      note(total)
      break
    case 'square':
    default:
      total = ~total
  }
  const picked = names.filter(name => name.trim().length > 0).map(name => name.toUpperCase())
  const first = picked[0]?.charAt(0) ?? ''
  const safe = names?.[0]?.startsWith('a') ? Math.min(total, 1) : Math.max(total, 2)
  const tagged = String.raw`raw ${total}`
  const label = 'value: ' + total + first
  const numeric = +label.length
  names.sort()
  names.reverse().slice(1)
  if (safe > 5) throw new Error(tagged + numeric)
  return label
}

class Counter {
  static created = 0
  items = []
  constructor(label, step = 1) {
    this.label = label
    this.step = step
    Counter.created++
  }
  add(item) {
    this.items.push(item)
    this.step ||= 2
    this.step &&= 3
    this.step ??= 4
    this.step <<= 1
    return this
  }
  get size() { return this.items.length * this.step }
  names = () => this.items.map(item => item.name)
}

class Derived extends Counter {
  extra = true
  constructor() {
    super('derived')
    note(this.extra)
  }
}

const identity = x => x
const nothing = () => undefined
const boxed = () => ({ a: 1, b: [2] })
const settings = { verbose: false, 'quoted key': 1, nested: { list: [1, 2, 3] } }
let hits = 0
const ready = true
ready === true && hits++
hits + 1 > 0 ? note('positive') : note('zero')
delete settings.nested.missing
settings.nested.list.filter(Boolean)[0] === 1 || note('unexpected')
let swapA = 1, swapB = 2;
[swapA, swapB] = [swapB, swapA]

function attempt(run) {
  try {
    const value = run()
    return value === undefined ? 'undefined' : JSON.stringify(value)
  } catch (error) {
    return 'threw ' + error.constructor.name + ': ' + error.message
  }
}

function run() {
  return [
    attempt(() => classify(3, 'circle', ['b', ' a'])),
    attempt(() => classify(120, 'circle', ['x'])),
    attempt(() => classify(7, 'square', [])),
    attempt(() => classify(4, 'square', ['abc', '', 'zeta'])),
    attempt(() => classify(600, 'other', ['q'])),
    attempt(() => new Counter('c', 0).add({ name: 'n' }).size),
    attempt(() => new Counter('c').add({ name: 'n' }).add({ name: 'm' }).names()),
    attempt(() => [new Derived().label, Counter.created, new Derived().extra]),
    attempt(() => [identity(5), nothing(), boxed(), identity.name, nothing.name, boxed.name]),
    attempt(() => [digits.test('12ab'), digits.test('ab'), spaced.test('aa c'), spaced.test('a b')]),
    attempt(() => [settings, hits, swapA, swapB, limits.empty.length, log.slice()]),
  ]
}
