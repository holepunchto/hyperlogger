const PREVIEW_LIMIT = 32
const DEFAULT_MAX_DEPTH = 2

// Settings fixed for the whole call. Build once (e.g. per logger) and reuse.
function createOptions({ maxDepth = DEFAULT_MAX_DEPTH } = {}) {
  return Object.freeze({ maxDepth })
}

const DEFAULT_OPTIONS = createOptions()

function normaliseAttributes(value, opts = DEFAULT_OPTIONS) {
  // Changes as the traversal runs. Fresh for every call.
  const state = {
    seen: new WeakSet(),
    depth: 0,
    bytes: 0,
    truncated: false
  }

  const attributes = normalise(value, opts, state)

  return attributes
}

function normalise(value, opts, state) {
  try {
    if (value === null) return null

    switch (typeof value) {
      case 'string':
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
      )
        return formatArrayBuffer(value)

      if (Array.isArray(value)) {
        return Array.from({ length: value.length }, (_, i) => read(value, i, opts, state))
      }

      if (value instanceof Error) {
        return {
          name: read(value, 'name', opts, state),
          message: read(value, 'message', opts, state),
          stack: read(value, 'stack', opts, state)
        }
      }

      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        return '[Unsupported object]'
      }

      return Object.fromEntries(
        Object.keys(value).map((key) => [key, read(value, key, opts, state)])
      )
    } finally {
      state.seen.delete(value)
      state.depth -= 1
    }
  } catch {
    return '[Unserializable]'
  }
}

function formatMap(value, opts, state) {
  const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(value)
  const iterator = Map.prototype.entries.call(value)
  const items = []

  for (let i = 0; i < Math.min(size, PREVIEW_LIMIT); i++) {
    const item = iterator.next().value

    const key = formatPreview(normalise(item[0], opts, state))
    const val = formatPreview(normalise(item[1], opts, state))

    items.push(`${key} => ${val}`)
  }

  if (size > PREVIEW_LIMIT) items.push(`... ${size - PREVIEW_LIMIT} more items`)

  return `Map(${size}) {${items.length ? ' ' + items.join(', ') + ' ' : ''}}`
}

function formatSet(value, opts, state) {
  const size = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get.call(value)
  const iterator = Set.prototype.values.call(value)
  const items = []

  for (let i = 0; i < Math.min(size, PREVIEW_LIMIT); i++) {
    const item = iterator.next().value

    const el = formatPreview(normalise(item, opts, state))

    items.push(el)
  }

  if (size > PREVIEW_LIMIT) items.push(`... ${size - PREVIEW_LIMIT} more items`)

  return `Set(${size}) {${items.length ? ' ' + items.join(', ') + ' ' : ''}}`
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

module.exports = normaliseAttributes
module.exports.createOptions = createOptions
