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
  ['large array', [...Array(1_000).keys()], [...Array(100).keys(), '... 900 more items']],
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
  t.alike(
    normaliseAttribute({ values: [1n, { missing: undefined }, [NaN, false]] }, { maxDepth: 10 }),
    {
      values: ['1', { missing: '[Undefined]' }, ['NaN', false]]
    }
  )
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

test('normalise - errors preserve name, message, stack, and code when present', (t) => {
  const error = new TypeError('bad input')
  error.stack = 'TypeError: bad input\n    at example'
  error.code = 'TEST_FAILURE'
  t.alike(normaliseAttribute(error), {
    name: 'TypeError',
    message: 'bad input',
    stack: error.stack,
    code: error.code
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
  const result = normaliseAttribute(input, { maxDepth: 10 })
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

test('normalise - a throwing array getter keeps good elements', (t) => {
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
  const result = normaliseAttribute({ deep, sibling: 42 }, { maxDepth: 10 })
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

test('normalise - long strings are cut with a marker', (t) => {
  t.is(
    normaliseAttribute('a'.repeat(10_000)),
    'a'.repeat(10_000),
    'exactly at the limit is kept whole'
  )
  t.is(normaliseAttribute('a'.repeat(10_005)), 'a'.repeat(10_000) + '... 5 more characters')
  t.alike(normaliseAttribute({ s: 'b'.repeat(10_001) }), {
    s: 'b'.repeat(10_000) + '... 1 more characters'
  })
})

test('normalise - string cut does not split a surrogate pair', (t) => {
  const input = 'a'.repeat(9_999) + '😀' + 'tail'
  const result = normaliseAttribute(input)
  t.is(result, 'a'.repeat(9_999) + '... 6 more characters')
  t.ok(!JSON.stringify(result).includes('\\ud83d'), 'no lone surrogate escape in the JSON')
})

test('normalise - budget chops off the remaining fields of a large object', (t) => {
  const input = Object.fromEntries(Array.from({ length: 500 }, (_, i) => ['k' + i, i]))
  const result = normaliseAttribute(input, normaliseAttribute.createOptions({ maxBytes: 100 }))
  const keys = Object.keys(result)

  t.alike(
    keys,
    ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', '...'],
    'keeps the first fields in order'
  )
  t.is(result['...'], '493 more keys', 'says how many fields were dropped')
  for (let i = 0; i <= 6; i++) t.is(result['k' + i], i, 'kept values are untouched')
  t.is(JSON.stringify(result).length, 72)
})

test('normalise - budget is shared, so a large first key crowds out its siblings', (t) => {
  const a = Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['f' + i, 'x']))
  const result = normaliseAttribute(
    { a, b: { y: 1 } },
    normaliseAttribute.createOptions({ maxBytes: 60, maxDepth: 5 })
  )

  t.alike(result, {
    a: { f0: 'x', f1: 'x', f2: 'x', f3: 'x', f4: 'x', f5: 'x', '...': '44 more keys' },
    '...': '1 more keys'
  })
})

test('normalise - budget chops the remaining elements of an array', (t) => {
  const input = Array.from({ length: 30 }, (_, i) => i)
  const result = normaliseAttribute(input, normaliseAttribute.createOptions({ maxBytes: 40 }))

  t.alike(result, [0, 1, 2, 3, 4, '... 25 more items'])
})

test('normalise - values under the budget are not chopped', (t) => {
  const input = { name: 'hyperlogger', count: 3, tags: ['a', 'b'] }
  const result = normaliseAttribute(input, normaliseAttribute.createOptions({ maxBytes: 200 }))

  t.alike(result, input)
})

test('normalise - a 256 KB budget keeps a huge object close to 256 KB', (t) => {
  const input = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => ['key' + i, 'val' + i]))
  const result = normaliseAttribute(input, normaliseAttribute.createOptions({ maxBytes: 262_144 }))
  const keys = Object.keys(result)
  const bytes = JSON.stringify(result).length

  t.is(keys.length, 12_926 + 1, 'kept fields plus the marker')
  t.is(result['...'], '37074 more keys')
  t.ok(Math.abs(bytes - 262_144) <= 50, `JSON is ${bytes} bytes, within 50 of the budget`)
})

test('normalise - options left out get their defaults', (t) => {
  const { createOptions } = normaliseAttribute
  t.alike(createOptions(), { maxDepth: 6, maxBytes: 262_144 })
  t.alike(createOptions({ maxDepth: undefined, maxBytes: undefined }), {
    maxDepth: 6,
    maxBytes: 262_144
  })
})

test('normalise - invalid options throw', (t) => {
  const { createOptions } = normaliseAttribute

  for (const bad of [null, NaN, '10', -1, 0, 0.5, {}]) {
    const label = typeof bad === 'number' ? String(bad) : JSON.stringify(bad)
    t.exception.all(
      () => createOptions({ maxDepth: bad }),
      /maxDepth must be a whole number from 1 to 100/,
      `maxDepth ${label}`
    )
    t.exception.all(
      () => createOptions({ maxBytes: bad }),
      /maxBytes must be a whole number from 1 to 2097152/,
      `maxBytes ${label}`
    )
  }
})

test('normalise - options above their limit, or not whole numbers, throw', (t) => {
  const { createOptions } = normaliseAttribute

  t.alike(
    createOptions({ maxDepth: 100, maxBytes: 2_097_152 }),
    { maxDepth: 100, maxBytes: 2_097_152 },
    'the limits themselves are allowed'
  )
  t.alike(createOptions({ maxDepth: 1, maxBytes: 1 }), { maxDepth: 1, maxBytes: 1 }, 'and so is 1')

  for (const bad of [101, 1000, Infinity, 3.7]) {
    t.exception.all(
      () => createOptions({ maxDepth: bad }),
      /maxDepth must be a whole number from 1 to 100/,
      `maxDepth ${bad}`
    )
  }
  for (const bad of [2_097_153, 1e9, Infinity, 1000.9]) {
    t.exception.all(
      () => createOptions({ maxBytes: bad }),
      /maxBytes must be a whole number from 1 to 2097152/,
      `maxBytes ${bad}`
    )
  }
})

test('normalise - the deepest allowed maxDepth, 100, stops at 100 levels', (t) => {
  let deep = { leaf: true }
  for (let i = 0; i < 150; i++) deep = { child: deep }
  const result = normaliseAttribute(deep, normaliseAttribute.createOptions({ maxDepth: 100 }))
  let node = result
  for (let i = 0; i < 99; i++) node = node.child
  t.is(node.child, '[MaxDepth]')
})

test('normalise - huge empty sparse array is capped, not expanded', (t) => {
  const input = []
  input.length = 1e9
  const result = normaliseAttribute(input)

  t.is(result.length, 101)
  t.alike(result.slice(0, 100), Array(100).fill('[Undefined]'))
  t.is(result[100], '... 999999900 more items')
})

test('normalise - huge sparse array keeps the values it has', (t) => {
  const input = []
  input.length = 1e9
  input[0] = 1
  input[5] = 'x'
  const result = normaliseAttribute(input)

  const expected = Array(100).fill('[Undefined]')
  expected[0] = 1
  expected[5] = 'x'
  expected.push('... 999999900 more items')
  t.alike(result, expected)
})

test('normalise - set preview is counted once, as its final string', (t) => {
  const input = { s: new Set(['aa', 'bb', 'cc']), z: 1 }
  const preview = "Set(3) { 'aa', 'bb', 'cc' }"
  const { createOptions } = normaliseAttribute

  t.alike(normaliseAttribute(input, createOptions({ maxBytes: 36 })), {
    s: preview,
    '...': '1 more keys'
  })
  t.alike(normaliseAttribute(input, createOptions({ maxBytes: 37 })), { s: preview, z: 1 })
})

test('normalise - map preview is counted once, as its final string', (t) => {
  const input = {
    m: new Map([
      ['a', 1],
      ['b', 2]
    ]),
    after: 'still here?'
  }
  const preview = "Map(2) { 'a' => 1, 'b' => 2 }"
  const { createOptions } = normaliseAttribute

  t.alike(normaliseAttribute(input, createOptions({ maxBytes: 38 })), {
    m: preview,
    '...': '1 more keys'
  })
  t.alike(normaliseAttribute(input, createOptions({ maxBytes: 39 })), {
    m: preview,
    after: 'still here?'
  })
})

test('normalise - budget stops a map preview early', (t) => {
  const v = 'v'.repeat(50)
  const input = new Map(Array.from({ length: 10 }, (_, i) => [i, v]))
  const result = normaliseAttribute(input, normaliseAttribute.createOptions({ maxBytes: 120 }))

  t.is(result, `Map(10) { 0 => '${v}', 1 => '${v}', ... 8 more items }`)
})

test('normalise - object keys longer than 1000 characters are cut with a marker', (t) => {
  const huge = 'k'.repeat(5 * 1024 * 1024) // 5 MiB
  const result = normaliseAttribute({ [huge]: 1, after: 2 })

  t.alike(result, { ['k'.repeat(1000) + '... 5241880 more characters']: 1, after: 2 })
  t.ok(JSON.stringify(result).length < 2000, 'the record stays small')
})

test('normalise - a key exactly at the limit is kept whole', (t) => {
  const atLimit = 'k'.repeat(1000)
  const overLimit = 'k'.repeat(1001)

  t.alike(Object.keys(normaliseAttribute({ [atLimit]: 1 })), [atLimit])
  t.alike(Object.keys(normaliseAttribute({ [overLimit]: 1 })), [atLimit + '... 1 more characters'])
})

test('normalise - keys that are identical once cut keep the first value', (t) => {
  const prefix = 'a'.repeat(1000)

  // same length after the prefix: both cut to the same key
  const clash = normaliseAttribute({
    [prefix + 'x'.repeat(500)]: 'first',
    [prefix + 'y'.repeat(500)]: 'second'
  })
  t.alike(clash, { [prefix + '... 500 more characters']: 'first' })

  // different lengths: the markers differ, so both are kept
  const distinct = normaliseAttribute({
    [prefix + 'x'.repeat(500)]: 'first',
    [prefix + 'y'.repeat(600)]: 'second'
  })
  t.alike(distinct, {
    [prefix + '... 500 more characters']: 'first',
    [prefix + '... 600 more characters']: 'second'
  })
})

test('normalise - a huge key can only overshoot the budget by one capped key', (t) => {
  const huge = 'k'.repeat(5 * 1024 * 1024)
  const result = normaliseAttribute(
    { [huge]: 1, after: 2 },
    normaliseAttribute.createOptions({ maxBytes: 500 })
  )

  t.alike(result, { ['k'.repeat(1000) + '... 5241880 more characters']: 1, '...': '1 more keys' })
  t.ok(JSON.stringify(result).length < 500 + 1100, 'over by at most about one capped key')
})
