const PREVIEW_LIMIT = 32

function normaliseAttribute(value) {
  return normalise(value, (seen = new WeakSet()), (depth = 0))
}

function normalise(value, seen, depth) {
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

    if (seen.has(value)) return '[Circular]'
    if (depth >= 10) return '[MaxDepth]'

    seen.add(value)
    depth += 1

    try {
      if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString()
      }

      if (value instanceof Map) return formatMap(value, seen, depth)

      if (value instanceof Set) return formatSet(value, seen, depth)

      if (
        ArrayBuffer.isView(value) ||
        value instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
      )
        return formatArrayBuffer(value)

      if (Array.isArray(value)) {
        return Array.from({ length: value.length }, (_, i) => read(value, i, seen, depth))
      }

      if (value instanceof Error) {
        return {
          name: read(value, 'name', seen, depth),
          message: read(value, 'message', seen, depth),
          stack: read(value, 'stack', seen, depth)
        }
      }

      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        return '[Unsupported object]'
      }

      return Object.fromEntries(
        Object.keys(value).map((key) => [key, read(value, key, seen, depth)])
      )
    } finally {
      seen.delete(value)
    }
  } catch {
    return '[Unserializable]'
  }
}

function formatMap(value, seen, depth) {
  const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(value)
  const iterator = Map.prototype.entries.call(value)
  const items = []

  for (let i = 0; i < Math.min(size, PREVIEW_LIMIT); i++) {
    const item = iterator.next().value

    const key = formatPreview(normalise(item[0], seen, depth))
    const val = formatPreview(normalise(item[1], seen, depth))

    items.push(`${key} => ${val}`)
  }

  if (size > PREVIEW_LIMIT) items.push(`... ${size - PREVIEW_LIMIT} more items`)

  return `Map(${size}) {${items.length ? ' ' + items.join(', ') + ' ' : ''}}`
}

function formatSet(value, seen, depth) {
  const size = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get.call(value)
  const iterator = Set.prototype.values.call(value)
  const items = []

  for (let i = 0; i < Math.min(size, PREVIEW_LIMIT); i++) {
    const item = iterator.next().value

    const el = formatPreview(normalise(item, seen, depth))

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
function read(value, key, seen, depth) {
  try {
    return normalise(value[key], seen, depth)
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

module.exports = normaliseAttribute
