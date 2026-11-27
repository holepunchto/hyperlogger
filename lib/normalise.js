const PREVIEW_LIMIT = 32
const MAX_ARRAY_LENGTH = 100
const MAX_STRING_LENGTH = 10_000
const MAX_KEY_LENGTH = 1_000

const DEFAULT_MAX_DEPTH = 6
const DEFAULT_MAX_BYTES = 262_144

const MAX_DEPTH_LIMIT = 100
const MAX_BYTES_LIMIT = 2_097_152

function createOptions({ maxDepth, maxBytes } = {}) {
  return Object.freeze({
    maxDepth: checkOption('maxDepth', maxDepth, DEFAULT_MAX_DEPTH, MAX_DEPTH_LIMIT),
    maxBytes: checkOption('maxBytes', maxBytes, DEFAULT_MAX_BYTES, MAX_BYTES_LIMIT)
  })
}

function checkOption(name, value, fallback, limit) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > limit) {
    throw new RangeError(`${name} must be a whole number from 1 to ${limit}: ${value}`)
  }
  return value
}

const DEFAULT_OPTIONS = createOptions()

function normaliseAttributes(value, opts = DEFAULT_OPTIONS) {
  // Changes as the traversal runs. Fresh for every call.
  const state = {
    seen: new WeakSet(),
    depth: 0,
    bytes: 0
  }

  return normalise(value, opts, state)
}

function normalise(value, opts, state) {
  const out = normaliseValue(value, opts, state)
  if (out === null || typeof out !== 'object') state.bytes += cost(out) // primitives only
  return out
}

function normaliseValue(value, opts, state) {
  try {
    if (value === null) return null

    switch (typeof value) {
      case 'string':
        return formatString(value)
      case 'boolean':
        return value
      case 'number':
        return Number.isFinite(value) ? value : String(value)
      case 'bigint':
        return value.toString()
      case 'undefined':
        return '[Undefined]'
      case 'function':
        return '[Function]'
      case 'symbol':
        return String(value)
    }

    if (state.seen.has(value)) return '[Circular]'
    if (state.depth >= opts.maxDepth) return '[MaxDepth]'

    state.seen.add(value)
    state.depth += 1

    try {
      if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString()
      }

      if (value instanceof Map) return formatMap(value, opts, state)

      if (value instanceof Set) return formatSet(value, opts, state)

      if (
        ArrayBuffer.isView(value) ||
        value instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
      ) {
        return formatArrayBuffer(value)
      }

      if (Array.isArray(value)) {
        return formatArray(value, opts, state)
      }

      if (value instanceof Error) {
        const err = {
          name: read(value, 'name', opts, state),
          message: read(value, 'message', opts, state),
          stack: read(value, 'stack', opts, state)
        }

        const code = read(value, 'code', opts, state)
        if (code !== '[Undefined]') err.code = code

        state.bytes += 2
        for (const key of Object.keys(err)) state.bytes += key.length + 4

        return err
      }

      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        return '[Unsupported object]'
      }

      return formatObject(value, opts, state)
    } finally {
      state.seen.delete(value)
      state.depth -= 1
    }
  } catch (err) {
    return '[Unserializable]'
  }
}

// The preview comes out of normalise as one string and is counted
// in full there. Children still count while it's built, so the
// budget checks work, then the total is put back so they aren't
// counted twice.
function formatMap(value, opts, state) {
  const bytes = state.bytes

  try {
    const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(value)
    const iterator = Map.prototype.entries.call(value)
    const items = []
    const limit = Math.min(size, PREVIEW_LIMIT)

    for (let i = 0; i < limit; i++) {
      if (state.bytes >= opts.maxBytes) break

      const item = iterator.next().value

      const key = formatPreview(normalise(item[0], opts, state))
      const val = formatPreview(normalise(item[1], opts, state))

      items.push(`${key} => ${val}`)
    }

    if (size > items.length) items.push(`... ${size - items.length} more items`)

    return `Map(${size}) {${items.length ? ' ' + items.join(', ') + ' ' : ''}}`
  } finally {
    state.bytes = bytes
  }
}

// Counted the same way as formatMap.
function formatSet(value, opts, state) {
  const bytes = state.bytes

  try {
    const size = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get.call(value)
    const iterator = Set.prototype.values.call(value)
    const items = []
    const limit = Math.min(size, PREVIEW_LIMIT)

    for (let i = 0; i < limit; i++) {
      if (state.bytes >= opts.maxBytes) break

      const item = iterator.next().value

      const el = formatPreview(normalise(item, opts, state))

      items.push(el)
    }

    if (size > items.length) items.push(`... ${size - items.length} more items`)

    return `Set(${size}) {${items.length ? ' ' + items.join(', ') + ' ' : ''}}`
  } finally {
    state.bytes = bytes
  }
}

function formatArrayBuffer(value) {
  const isView = ArrayBuffer.isView(value)
  const length = value.byteLength
  const bytes = new Uint8Array(
    isView ? value.buffer : value,
    isView ? value.byteOffset : 0,
    Math.min(length, PREVIEW_LIMIT)
  )

  const items = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))

  if (length > PREVIEW_LIMIT) items.push(`... ${length - PREVIEW_LIMIT} more bytes`)

  const name = Object.getPrototypeOf(value).constructor.name

  return `${name}<${items.join(' ')}>`
}

function formatString(value, maxLength = MAX_STRING_LENGTH) {
  if (value.length <= maxLength) return value

  let end = maxLength
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--

  return value.slice(0, end) + `... ${value.length - end} more characters`
}

// Elements are counted on their way out of normalise, so only
// the brackets and the comma after each element are counted here.
function formatArray(value, opts, state) {
  const array = []
  const size = Math.min(value.length, MAX_ARRAY_LENGTH)

  state.bytes += 2

  for (let i = 0; i < size; i++) {
    if (state.bytes >= opts.maxBytes) break

    state.bytes += 1
    array.push(read(value, i, opts, state))
  }

  const remainder = value.length - array.length

  if (remainder > 0) array.push(`... ${remainder} more items`)

  return array
}

// Values are counted on their way out of normalise, so only the
// object's own structure is counted here: the braces, and each
// key with its quotes, colon and comma.
function formatObject(value, opts, state) {
  const keys = Object.keys(value)
  const entries = []
  const written = new Set()

  state.bytes += 2

  for (let i = 0; i < keys.length; i++) {
    if (state.bytes >= opts.maxBytes) {
      entries.push(['...', `${keys.length - i} more keys`])
      break
    }

    // long keys are cut like long strings; the marker keeps the original length, so
    // two long keys only end up identical if they also have the same length
    const key = formatString(keys[i], MAX_KEY_LENGTH)

    // keys identical after cutting: keep the first rather than overwriting it
    if (written.has(key)) continue
    written.add(key)

    state.bytes += key.length + 4
    entries.push([key, read(value, keys[i], opts, state)])
  }

  return Object.fromEntries(entries)
}

// Catch property getters that throw.
function read(value, key, opts, state) {
  try {
    return normalise(value[key], opts, state)
  } catch {
    return '[Unserializable]'
  }
}

// Values have already passed through the normaliser, so no user methods run here.
function formatPreview(value) {
  if (typeof value === 'string') {
    return "'" + JSON.stringify(value).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'") + "'"
  }
  if (Array.isArray(value)) return `[ ${value.map(formatPreview).join(', ')} ]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, child]) => {
      const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : formatPreview(key)
      return `${name}: ${formatPreview(child)}`
    })
    return entries.length ? `{ ${entries.join(', ')} }` : '{}'
  }
  return String(value)
}

// flat guess of the average number's string size
// may over or under count.
const NUMBER_COST = 8

function cost(value) {
  switch (typeof value) {
    case 'string':
      return value.length + 2 // quotes
    case 'number':
      return NUMBER_COST
    case 'boolean':
      return value ? 4 : 5
    default:
      return 4 // null
  }
}

module.exports = normaliseAttributes
module.exports.createOptions = createOptions
