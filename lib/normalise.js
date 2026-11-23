const PREVIEW_LIMIT = 32

function normaliseAttribute(value, seen = new WeakSet(), depth = 0) {
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

    try {
      if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString()
      }

      const normalise = (child) => normaliseAttribute(child, seen, depth + 1)

      // Catch property getters that throw.
      const read = (key) => {
        try {
          return normalise(value[key])
        } catch {
          return '[Unserializable]'
        }
      }

      if (value instanceof Map || value instanceof Set) {
        const isMap = value instanceof Map
        const size = isMap
          ? Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(value)
          : Object.getOwnPropertyDescriptor(Set.prototype, 'size').get.call(value)
        const iterator = isMap
          ? Map.prototype.entries.call(value)
          : Set.prototype.values.call(value)
        const items = []

        for (let i = 0; i < Math.min(size, PREVIEW_LIMIT); i++) {
          const item = iterator.next().value
          items.push(
            isMap
              ? `${formatPreview(normalise(item[0]))} => ${formatPreview(normalise(item[1]))}`
              : formatPreview(normalise(item))
          )
        }

        if (size > PREVIEW_LIMIT) items.push(`... ${size - PREVIEW_LIMIT} more items`)
        const name = isMap ? 'Map' : 'Set'
        return `${name}(${size}) {${items.length ? ' ' + items.join(', ') + ' ' : ''}}`
      }

      if (
        ArrayBuffer.isView(value) ||
        value instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
      ) {
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

      if (Array.isArray(value)) {
        return Array.from({ length: value.length }, (_, i) => read(i))
      }

      if (value instanceof Error) {
        return {
          name: read('name'),
          message: read('message'),
          stack: read('stack')
        }
      }

      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        return '[Unsupported object]'
      }

      return Object.fromEntries(Object.keys(value).map((key) => [key, read(key)]))
    } finally {
      seen.delete(value)
    }
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
