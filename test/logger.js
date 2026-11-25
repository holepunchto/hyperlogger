const test = require('brittle')
const hrtime = require('#hrtime')
const fs = require('fs')
const path = require('path')
const Hyperlogger = require('../index')

test('check all standard log types produce outputs', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'logs')
  const logger = new Hyperlogger({ level: 'DEBUG', file })

  t.teardown(() => logger.close())

  const msg1 = 'hi'
  const msg2 = 'there'
  const attr = { test: 'success' }

  logger.debug(msg1, msg2, attr)
  logger.info(msg1, msg2, attr)
  logger.warn(msg1, msg2, attr)
  logger.error(msg1, msg2, attr)

  const rawLogs = fs.readFileSync(file, { encoding: 'utf8' })
  const logs = Hyperlogger.parseLogs(rawLogs)

  const expectedLogs = ['DEBUG', 'INFO', 'WARN', 'ERROR'].map((level) => ({
    timeUnixNano: '0',
    observedTimeUnixNano: '0',
    severityNumber: Hyperlogger.LEVELS[level],
    severityText: level,
    body: `${msg1} ${msg2}`,
    attributes: attr
  }))

  // Timestamps vary between calls; compare the remaining fields.
  const withoutTimestamps = ({ timeUnixNano, observedTimeUnixNano, ...log }) => log
  t.alike(
    logs.map(withoutTimestamps),
    expectedLogs.map(withoutTimestamps),
    'expected logs match actual logs'
  )
})

test('logger serializes normalized attributes without mutating the input', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'logs')
  const logger = new Hyperlogger({ file })
  t.teardown(() => logger.close())

  const attrs = { count: 42n, date: new Date('2026-01-01T00:00:00Z') }
  attrs.self = attrs
  Object.defineProperty(attrs, 'broken', {
    enumerable: true,
    get() {
      throw new Error('cannot read attribute')
    }
  })

  logger.info('normalized', attrs)

  const logs = Hyperlogger.parseLogs(fs.readFileSync(file, 'utf8'))
  t.is(logs.length, 1)
  t.alike(logs[0].attributes, {
    count: '42',
    date: '2026-01-01T00:00:00.000Z',
    self: '[Circular]',
    broken: '[Unserializable]'
  })
  t.is(attrs.count, 42n)
  t.is(attrs.self, attrs)
})

test('timing log output is JSON with timing in the log body', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'logs')
  const logger = new Hyperlogger({ file })

  t.teardown(() => logger.close())

  const label = 'test'

  logger.time(label)
  logger.timeLog(label, 'this is a test', { test: 'success' })
  logger.timeEnd(label, { test: 'end' })

  const rawLogs = fs.readFileSync(file, { encoding: 'utf8' })
  const logs = Hyperlogger.parseLogs(rawLogs)

  const withoutTimestamps = ({ timeUnixNano, observedTimeUnixNano, ...log }) => log
  const timingLogs = logs.map(withoutTimestamps)

  t.alike(
    timingLogs.map(({ body, ...fields }) => fields),
    [
      {
        severityNumber: Hyperlogger.LEVELS.INFO,
        severityText: 'INFO',
        attributes: { test: 'success' }
      },
      { severityNumber: Hyperlogger.LEVELS.INFO, severityText: 'INFO', attributes: { test: 'end' } }
    ],
    'timing logs contain exactly the expected fields apart from timestamps and body'
  )
  t.ok(
    /^test: \d+\.\d{3}(?:ms|s) this is a test$/.test(timingLogs[0]?.body),
    'timeLog body contains the label, formatted duration and message'
  )
  t.ok(
    /^test: \d+\.\d{3}(?:ms|s)$/.test(timingLogs[1]?.body),
    'timeEnd body contains only the label and formatted duration'
  )
})

test('logger passes maxBytes through to the attributes', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'logs')
  const logger = new Hyperlogger({ file, maxBytes: 50 })

  t.teardown(() => logger.close())

  logger.info('x', Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['k' + i, i])))

  const [log] = Hyperlogger.parseLogs(fs.readFileSync(file, { encoding: 'utf8' }))
  t.alike(log.attributes, { k0: 0, k1: 1, k2: 2, k3: 3, '...': '96 more keys' })
})

test('loggers sharing a path never rotate the file out from under each other', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'app.log')
  const LOGGERS = 10
  const ROUNDS = 7

  // Records are identical, so every line is `size` bytes
  const body = (logger, n) =>
    `logger ${String(logger).padStart(2, '0')} line ${String(n).padStart(4, '0')}`
  const attributes = (n) => ({ n: String(n).padStart(4, '0') })
  const exampleRecord = {
    timeUnixNano: '0'.repeat(19),
    observedTimeUnixNano: '0'.repeat(19),
    severityNumber: Hyperlogger.LEVELS.INFO,
    severityText: 'INFO',
    body: body(0, 0),
    attributes: attributes(0)
  }
  const size = JSON.stringify(exampleRecord).length + 1

  // a file rotates once it goes over maxSize.
  // so 6 * size - 1 holds exactly 6 lines;
  const perFile = 6
  const maxTotalSize = 10 * (perFile * size - 1)

  const loggers = []
  for (let i = 0; i < LOGGERS; i++) {
    const logger = new Hyperlogger({ file, maxTotalSize })
    t.teardown(() => logger.close())
    loggers.push(logger)
  }

  t.is(new Set(loggers.map((l) => l._file)).size, 1, 'all loggers share one writer')

  // loggers take turns writing lines
  for (let r = 0; r < ROUNDS; r++) {
    for (let i = 0; i < LOGGERS; i++) {
      const n = r * LOGGERS + i
      loggers[i].info(body(i, n), attributes(n))
    }
  }

  // 70 lines written in total, causing 11 rotations at 6 per file:
  // lines 0 to 11 are deleted, and there are 4 lines in the live file
  const total = LOGGERS * ROUNDS
  const rotations = Math.floor(total / perFile)
  const live = total % perFile
  const firstKept = (rotations - 9) * perFile

  const expectedNames = ['app.log', ...Array.from({ length: 9 }, (_, i) => `app.log.${i + 1}`)]
  t.alike(
    fs.readdirSync(dir).toSorted(),
    expectedNames.toSorted(),
    'the live file plus 9 older ones'
  )

  for (let i = 1; i <= 9; i++) {
    t.is(readLines(`${file}.${i}`).length, perFile, `app.log.${i} holds ${perFile} lines`)
  }
  t.is(readLines(file).length, live, `app.log holds the last ${live} lines`)

  const all = readAll(file)

  const expected = []
  for (let n = firstKept; n < total; n++) {
    expected.push({ body: body(n % LOGGERS, n), attributes: attributes(n) })
  }

  t.alike(
    all.map(({ body, attributes }) => ({ body, attributes })),
    expected,
    `lines ${firstKept} to ${total - 1}, in order, each from the logger that wrote it`
  )

  const lengths = new Set()
  for (const name of fs.readdirSync(dir)) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean)) {
      lengths.add(line.length + 1)
    }
  }
  t.alike([...lengths], [size], 'every line in every file is the expected fixed length')
})

test('logger formats errors to show message and code', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'logs')
  const logger = new Hyperlogger({ file, maxBytes: 50 })

  t.teardown(() => logger.close())

  logger.error('failed', new Error('boom'))

  const [log] = Hyperlogger.readLogs(file)
  t.ok(log.body.includes('failed Error: boom'), 'contains standard error message')
  t.ok(log.body.includes('at async Test._run'), 'stack trace references the brittle index')
})

test('level drops records below the minimum severity', async (t) => {
  const order = ['DEBUG', 'INFO', 'WARN', 'ERROR']

  for (const level of order) {
    const { file, logger } = await createLogger(t, { level })

    logger.debug('debug')
    logger.info('info')
    logger.warn('warn')
    logger.error('error')

    const kept = order.filter((l) => Hyperlogger.LEVELS[l] >= Hyperlogger.LEVELS[level])
    t.alike(severities(file), kept, `${level} keeps ${kept.join(', ')}`)
  }
})

test('mute stops all output until unmute', async (t) => {
  const { file, logger } = await createLogger(t, { level: 'DEBUG', verbose: true, dev: true })

  const printed = captureConsole(() => {
    logger.info('before')

    logger.mute()
    logger.debug('muted')
    logger.info('muted')
    logger.warn('muted')
    logger.error('muted')
    logger.verboseDebug('muted')
    logger.verboseInfo('muted')

    logger.unmute()
    logger.info('after')
  })

  t.alike(bodies(file), ['before', 'after'], 'nothing reached the file while muted')
  t.alike(
    printed,
    [
      ['info', 'before'],
      ['info', 'after']
    ],
    'nothing reached the console while muted'
  )
})

test('verbose methods only log when verbose is on, and still respect level', async (t) => {
  const off = await createLogger(t, { level: 'DEBUG', verbose: false })
  off.logger.verboseDebug('verbose debug')
  off.logger.verboseInfo('verbose info')
  off.logger.info('plain info')
  t.alike(bodies(off.file), ['plain info'], 'verbose off: verbose methods write nothing')

  const info = await createLogger(t, { level: 'INFO', verbose: true })
  info.logger.verboseDebug('verbose debug')
  info.logger.verboseInfo('verbose info')
  t.alike(bodies(info.file), ['verbose info'], 'verbose on at INFO: verboseDebug is still filtered')
  t.alike(severities(info.file), ['INFO'])

  const debug = await createLogger(t, { level: 'DEBUG', verbose: true })
  debug.logger.verboseDebug('verbose debug')
  debug.logger.verboseInfo('verbose info')
  t.alike(bodies(debug.file), ['verbose debug', 'verbose info'], 'verbose on at DEBUG: both write')
  t.alike(severities(debug.file), ['DEBUG', 'INFO'])
})

test('dev prints to the console only when the level is DEBUG', async (t) => {
  const run = async (opts) => {
    const { logger } = await createLogger(t, opts)
    return captureConsole(() => {
      logger.debug('d')
      logger.info('i', { attribute: true })
      logger.warn('w')
      logger.error('e')
    })
  }

  t.alike(
    await run({ dev: true, level: 'DEBUG' }),
    [
      ['debug', 'd'],
      ['info', 'i'],
      ['warn', 'w'],
      ['error', 'e']
    ],
    'dev at DEBUG: each level goes to its console method, without the attributes object'
  )
  t.alike(await run({ dev: true, level: 'INFO' }), [], 'dev at INFO: nothing printed')
  t.alike(await run({ dev: false, level: 'DEBUG' }), [], 'dev off: nothing printed')
})

test('after close, every method is safe to call and nothing more is written', async (t) => {
  const { file, logger } = await createLogger(t, { level: 'DEBUG', verbose: true, dev: true })
  const other = new Hyperlogger({ file }) // shares the same file
  t.teardown(() => other.close())

  const before = captureConsole(() => logger.info('before close'))
  t.alike(before, [['info', 'before close']], 'dev printing is on before close')

  logger.close()

  let threw = null
  const printed = captureConsole(() => {
    try {
      logger.debug('after close')
      logger.info('after close')
      logger.warn('after close')
      logger.error('after close')
      logger.verboseDebug('after close')
      logger.verboseInfo('after close')
      logger.time('timer')
      logger.timeLog('timer')
      logger.timeEnd('timer')
      logger.mute()
      logger.unmute()
      logger.close()
    } catch (err) {
      threw = err
    }
  })

  t.is(threw, null, 'no method throws after close')
  t.alike(bodies(file), ['before close'], 'nothing more was written')
  t.alike(printed, [], 'nothing was printed')

  other.info('other logger still writing')
  t.alike(
    bodies(file),
    ['before close', 'other logger still writing'],
    'closing one logger (even twice) does not close the file for another'
  )
})

test('timeEnd removes the timer', async (t) => {
  const { file, logger } = await createLogger(t)

  logger.time('task')
  logger.timeEnd('task')
  logger.timeLog('task')
  logger.timeEnd('task')

  t.is(readLines(file).length, 1, 'only the first timeEnd wrote anything')
})

test('timing an unknown label writes nothing', async (t) => {
  const { file, logger } = await createLogger(t)

  t.execution(() => {
    logger.timeLog('never started')
    logger.timeEnd('never started')
  })
  t.is(readLines(file).length, 0)
})

test('time with an existing label restarts it', async (t) => {
  const { file, logger } = await createLogger(t)

  const { advance } = clock(t)

  logger.time('task')
  advance(50)
  logger.time('task') // restart
  advance(10)
  logger.timeLog('task')

  t.is(durationMs(bodies(file)[0]), 10, 'measured from the restart, not the first call')
})

test('timeLog keeps the timer running', async (t) => {
  const { file, logger } = await createLogger(t)
  const { advance } = clock(t)

  logger.time('task')
  advance(5)
  logger.timeLog('task')
  advance(10)
  logger.timeLog('task')

  t.alike(bodies(file).map(durationMs), [5, 15], 'the second reading still counts from the start')
})

test('timers are separate for each logger', async (t) => {
  const a = await createLogger(t)
  const b = await createLogger(t)

  a.logger.time('task')
  b.logger.time('task')
  a.logger.timeEnd('task')
  b.logger.timeLog('task')

  t.is(readLines(a.file).length, 1)
  t.is(readLines(b.file).length, 1, "ending a's timer did not end b's")
})

test('timing lines follow level and mute', async (t) => {
  const warn = await createLogger(t, { level: 'WARN' })
  warn.logger.time('task')
  warn.logger.timeLog('task')
  warn.logger.timeEnd('task')
  t.is(readLines(warn.file).length, 0, 'timing is logged at INFO, so WARN drops it')

  const muted = await createLogger(t)
  muted.logger.time('task')
  muted.logger.mute()
  muted.logger.timeLog('task')
  muted.logger.timeEnd('task')
  t.is(readLines(muted.file).length, 0, 'nothing is written while muted')
})

test('durations over a second are shown in seconds', async (t) => {
  const { file, logger } = await createLogger(t)
  const { advance } = clock(t)

  logger.time('task')
  advance(999)
  logger.timeLog('task')
  advance(1)
  logger.timeLog('task')
  advance(234)
  logger.timeLog('task')

  t.alike(
    bodies(file),
    ['task: 999.000ms', 'task: 1000.000ms', 'task: 1.234s'],
    'milliseconds up to 1000, seconds above it'
  )
})

test('a logger with no file logs without throwing', (t) => {
  t.execution(() => {
    const logger = new Hyperlogger()
    logger.debug('d')
    logger.info('i', { attribute: true })
    logger.warn('w')
    logger.error('e', new Error('boom'))
    logger.close()
  })
})

test('records carry millisecond timestamps in nanoseconds', async (t) => {
  const { file, logger } = await createLogger(t)

  const before = BigInt(Date.now())
  logger.info('now')
  const after = BigInt(Date.now())

  const [record] = readLines(file)
  t.ok(/^\d{19}$/.test(record.timeUnixNano), 'the timestamp is a 19-digit string')
  t.ok(record.timeUnixNano.endsWith('000000'), 'the timestamp has millisecond precision')

  const time = BigInt(record.timeUnixNano)
  t.ok(
    time >= before * 1_000_000n && time <= after * 1_000_000n,
    'the timestamp is captured during the call'
  )
})

test('only a final plain object becomes attributes', async (t) => {
  const { file, logger } = await createLogger(t)

  class Point {
    constructor() {
      this.x = 1
    }
  }

  logger.info({ a: 1 }, 'x')
  logger.info('p', new Point())
  logger.info('a', 1, true, { kept: 'as attributes' })

  const [objectFirst, instanceLast, attributesLast] = readLines(file)

  t.alike(objectFirst.attributes, {})
  t.ok(
    objectFirst.body.includes('a: 1') && objectFirst.body.endsWith(' x'),
    'object shown in the body'
  )

  t.alike(instanceLast.attributes, {})
  t.ok(
    instanceLast.body.startsWith('p ') && instanceLast.body.includes('Point'),
    'instance shown in the body'
  )

  t.is(attributesLast.body, 'a 1 true', 'the body is arguments joined with spaces')
  t.alike(attributesLast.attributes, { kept: 'as attributes' }, 'attributes are kept as before')
})

test('placeholders in messages are not substituted', async (t) => {
  const { file, logger } = await createLogger(t)

  logger.info('done 50%d', 3)
  logger.info('100%% sure', 'x')

  t.alike(bodies(file), ['done 50%d 3', '100%% sure x'])
})

test('parseLogs ignores blank lines and incorrect JSON', (t) => {
  t.alike(Hyperlogger.parseLogs('\n{"a":1}\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }])
  t.alike(Hyperlogger.parseLogs('{"a":1}\nnot json\n'), [{ a: 1 }])
})

test('logger passes maxDepth through to the attributes', async (t) => {
  const shallow = await createLogger(t, { maxDepth: 1 })
  shallow.logger.info('x', { a: { b: 1 } })
  t.alike(
    readLines(shallow.file)[0].attributes,
    { a: '[MaxDepth]' },
    'small max depth clips object size'
  )

  const normal = await createLogger(t)
  normal.logger.info('x', { a: { b: 1 } })
  t.alike(readLines(normal.file)[0].attributes, { a: { b: 1 } }, 'the default goes deeper')
})

test('a missing log folder throws, and works once the folder exists', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'missing', 'app.log')

  t.exception.all(
    () => new Hyperlogger({ file }),
    /ENOENT/,
    'logger throws when given missing file path'
  )

  fs.mkdirSync(path.join(dir, 'missing'))
  const logger = new Hyperlogger({ file })
  t.teardown(() => logger.close())

  logger.info('now it works')
  t.alike(bodies(file), ['now it works'], 'the failed attempt left nothing behind')
})

async function createLogger(t, opts = {}) {
  // loggers have separate directories
  const dir = await t.tmp()
  const file = path.join(dir, 'app.log')
  const logger = new Hyperlogger({ file, ...opts })

  t.teardown(() => logger.close())

  return { file, logger }
}

function captureConsole(fn) {
  const methods = ['debug', 'info', 'warn', 'error', 'log']
  const original = {}
  const calls = []

  for (const m of methods) {
    original[m] = console[m]
    console[m] = (...args) => calls.push([m, ...args])
  }

  try {
    fn()
  } finally {
    for (const m of methods) console[m] = original[m]
  }

  return calls
}

function clock(t) {
  const bigint = hrtime.bigint
  let time = bigint()

  hrtime.bigint = () => time

  t.teardown(() => {
    hrtime.bigint = bigint
  })

  return {
    advance(ms) {
      time += BigInt(ms * 1_000_000)
    }
  }
}

function severities(file) {
  return readLines(file).map((record) => record.severityText)
}

// the duration in a timing body ("label: 12.345ms ..." or "label: 1.234s ..."), in ms
function durationMs(body) {
  const [, value, unit] = body.match(/: (\d+\.\d{3})(ms|s)/)
  return Number(value) * (unit === 's' ? 1000 : 1)
}

function bodies(file) {
  return readLines(file).map((record) => record.body)
}

// read all logs in write order
function readAll(file) {
  const all = []
  for (let i = 9; i >= 1; i--) all.push(...readLines(`${file}.${i}`))
  all.push(...readLines(file))

  return all
}

function readLines(file) {
  if (!fs.existsSync(file)) return []
  return Hyperlogger.parseLogs(fs.readFileSync(file, 'utf8'))
}
