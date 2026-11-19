const test = require('brittle')
const normaliseAttribute = require('../lib/normalise')

const cases = [
  ['string', 'hello', 'hello'],
  ['empty string', '', ''],
  ['true', true, true],
  ['false', false, false],
  ['zero', 0, 0],
  ['negative number', -42, -42],
  ['fraction', 1.25, 1.25],
  ['maximum safe integer', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ['NaN', NaN, 'NaN'],
  ['positive infinity', Infinity, 'Infinity'],
  ['negative infinity', -Infinity, '-Infinity'],
  ['null', null, null],
  ['undefined', undefined, '[Undefined]'],
  ['bigint zero', 0n, '0'],
  ['large bigint', 1800000000000000001n, '1800000000000000001'],
  ['negative bigint', -42n, '-42'],
  ['function', () => {}, '[Function]'],
  ['symbol', Symbol('test'), 'Symbol(test)'],
  ['unnamed symbol', Symbol(), 'Symbol()'],
  ['date', new Date('2026-01-02T03:04:05.678Z'), '2026-01-02T03:04:05.678Z'],
  ['epoch date', new Date(0), '1970-01-01T00:00:00.000Z'],
  ['invalid date', new Date(NaN), '[Invalid Date]'],
  ['empty array', [], []],
  ['empty object', {}, {}],
  ['map', new Map([['key', 'value']]), "Map(1) { 'key' => 'value' }"],
  ['set', new Set([1]), 'Set(1) { 1 }'],
  ['regexp', /test/, '[Unsupported object]'],
  ['typed array', new Uint8Array([1, 2]), 'Uint8Array<01 02>'],
  ['array buffer', new ArrayBuffer(4), 'ArrayBuffer<00 00 00 00>'],
  ['boxed number', Object(42), '[Unsupported object]'],
  ['boxed string', Object('hello'), '[Unsupported object]'],
  ['boxed boolean', Object(false), '[Unsupported object]'],
  ['class instance', new (class Example {})(), '[Unsupported object]']
]

for (const [name, input, expected] of cases) {
  test(`normalise - ${name}`, (t) => {
    const actual = normaliseAttribute(input)
    t.alike(actual, expected)
    // Every normalized value must survive JSON serialization.
    t.alike(JSON.parse(JSON.stringify(actual)), expected)
  })
}

test('normalise - nested arrays and objects preserve structure', (t) => {
  t.alike(normaliseAttribute({ values: [1n, { missing: undefined }, [NaN, false]] }), {
    values: ['1', { missing: '[Undefined]' }, ['NaN', false]]
  })
})

test('normalise - null-prototype objects', (t) => {
  const value = Object.create(null)
  value.count = 42n
  t.alike(normaliseAttribute(value), { count: '42' })
})

test('normalise - sparse array holes become explicit placeholders', (t) => {
  const value = new Array(3)
  value[1] = 42n
  t.alike(normaliseAttribute(value), ['[Undefined]', '42', '[Undefined]'])
})

test('normalise - errors preserve name, message and stack', (t) => {
  const error = new TypeError('bad input')
  error.stack = 'TypeError: bad input\n    at example'
  t.alike(normaliseAttribute(error), {
    name: 'TypeError',
    message: 'bad input',
    stack: error.stack
  })
})

test('normalise - circular objects and arrays preserve other values', (t) => {
  const object = { count: 1 }
  object.self = object
  const array = [2]
  array.push(array)
  t.alike(normaliseAttribute(object), { count: 1, self: '[Circular]' })
  t.alike(normaliseAttribute(array), [2, '[Circular]'])
})

test('normalise - indirect circular references', (t) => {
  const parent = { child: {} }
  parent.child.parent = parent
  t.alike(normaliseAttribute(parent), { child: { parent: '[Circular]' } })
})

test('normalise - shared references are not circular', (t) => {
  const shared = { count: 42n }
  const result = normaliseAttribute({ first: shared, second: shared })
  t.alike(result, { first: { count: '42' }, second: { count: '42' } })
  t.not(result.first, result.second)
})

test('normalise - frozen input is not mutated', (t) => {
  const nested = Object.freeze({ count: 42n })
  const items = Object.freeze([nested])
  const input = Object.freeze({ items })
  const result = normaliseAttribute(input)
  t.alike(result, { items: [{ count: '42' }] })
  t.is(input.items, items)
  t.is(items[0], nested)
  t.is(nested.count, 42n)
  t.not(result, input)
  t.not(result.items, items)
  t.not(result.items[0], nested)
})

test('normalise - throwing getters preserve sibling attributes', (t) => {
  const input = { good: 42n }
  Object.defineProperty(input, 'bad', {
    enumerable: true,
    get() {
      throw new Error('bad getter')
    }
  })
  t.alike(normaliseAttribute(input), { good: '42', bad: '[Unserializable]' })
})

test('normalise - throwing array getters', (t) => {
  const input = [1, 2]
  Object.defineProperty(input, '0', {
    get() {
      throw new Error('bad getter')
    }
  })
  t.alike(normaliseAttribute(input), ['[Unserializable]', 2])
})

test('normalise - throwing error getters', (t) => {
  const input = new Error('still readable')
  Object.defineProperty(input, 'stack', {
    get() {
      throw new Error('bad stack')
    }
  })
  t.alike(normaliseAttribute(input), {
    name: 'Error',
    message: 'still readable',
    stack: '[Unserializable]'
  })
})

test('normalise - throwing proxies become placeholders', (t) => {
  const input = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('cannot enumerate')
      }
    }
  )
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  t.is(normaliseAttribute(input), '[Unserializable]')
  t.is(normaliseAttribute(revoked.proxy), '[Unserializable]')
})

test('normalise - depth limit keeps sibling attributes', (t) => {
  let deep = { leaf: true }
  for (let i = 0; i < 20; i++) deep = { child: deep }
  const result = normaliseAttribute({ deep, sibling: 42 })
  let node = result.deep
  for (let i = 0; i < 9; i++) node = node.child
  t.is(node, '[MaxDepth]')
  t.is(result.sibling, 42)
  t.ok(JSON.stringify(result).includes('[MaxDepth]'))
})

test('normalise - custom toJSON is not invoked', (t) => {
  let calls = 0
  const input = {
    count: 42n,
    toJSON() {
      calls++
      throw new Error('must not be called')
    }
  }
  const result = normaliseAttribute(input)
  t.alike(result, { count: '42', toJSON: '[Function]' })
  t.is(JSON.stringify(result), '{"count":"42","toJSON":"[Function]"}')
  t.is(calls, 0)
})

test('normalise - symbol and non-enumerable keys are ignored', (t) => {
  const input = { visible: true, [Symbol('hidden')]: 42n }
  Object.defineProperty(input, 'hidden', { value: 1, enumerable: false })
  t.alike(normaliseAttribute(input), { visible: true })
})

test('normalise - __proto__ remains a data property', (t) => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value"}')
  const result = normaliseAttribute(input)
  t.is(Object.getPrototypeOf(result), Object.prototype)
  t.ok(Object.hasOwn(result, '__proto__'))
  t.is(result.polluted, undefined)
  t.alike(JSON.parse(JSON.stringify(result)), input)
})

test('normalise - collection previews are limited to 32 entries', (t) => {
  const values = Array.from({ length: 35 }, (_, i) => i)
  const set = normaliseAttribute(new Set(values))
  const map = normaliseAttribute(new Map(values.map((i) => [i, i])))
  t.is(set, `Set(35) { ${values.slice(0, 32).join(', ')}, ... 3 more items }`)
  t.is(
    map,
    `Map(35) { ${values
      .slice(0, 32)
      .map((i) => `${i} => ${i}`)
      .join(', ')}, ... 3 more items }`
  )
  t.is(normaliseAttribute(new Set()), 'Set(0) {}')
  t.is(normaliseAttribute(new Map()), 'Map(0) {}')
})

test('normalise - collection children retain error and circular protection', (t) => {
  const map = new Map()
  const set = new Set()
  map.set(map, { count: 42n })
  set.add(set)
  t.is(normaliseAttribute(map), "Map(1) { '[Circular]' => { count: '42' } }")
  t.is(normaliseAttribute(set), "Set(1) { '[Circular]' }")
  const child = { good: true }
  Object.defineProperty(child, 'bad', {
    enumerable: true,
    get() {
      throw new Error('bad')
    }
  })
  t.is(normaliseAttribute(new Set([child])), "Set(1) { { good: true, bad: '[Unserializable]' } }")
})

test('normalise - collection previews do not call custom iterators or toJSON', (t) => {
  const map = new Map([['key', 'value']])
  const set = new Set([1])
  for (const value of [map, set]) {
    value[Symbol.iterator] = value.toJSON = () => {
      throw new Error('must not run')
    }
  }
  t.is(normaliseAttribute(map), "Map(1) { 'key' => 'value' }")
  t.is(normaliseAttribute(set), 'Set(1) { 1 }')
})

test('normalise - binary previews show only the first 32 bytes', (t) => {
  const bytes = new Uint8Array(35).fill(255)
  const expected = Array(32).fill('ff').join(' ') + ' ... 3 more bytes'
  t.is(normaliseAttribute(bytes), `Uint8Array<${expected}>`)
  t.is(normaliseAttribute(bytes.buffer), `ArrayBuffer<${expected}>`)
  t.is(normaliseAttribute(new Uint8Array()), 'Uint8Array<>')
})

test('normalise - binary views respect byte offsets and lengths', (t) => {
  const bytes = new Uint8Array([99, 1, 2, 3, 99])
  t.is(normaliseAttribute(bytes.subarray(1, 4)), 'Uint8Array<01 02 03>')
  t.is(normaliseAttribute(new DataView(bytes.buffer, 1, 2)), 'DataView<01 02>')
  t.is(normaliseAttribute(Buffer.from([1, 2, 255])), 'Buffer<01 02 ff>')
  const words = new Uint16Array([0x1234])
  const expected = Array.from(new Uint8Array(words.buffer), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join(' ')
  t.is(normaliseAttribute(words), `Uint16Array<${expected}>`)
})
