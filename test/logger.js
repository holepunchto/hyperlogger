const test = require('brittle')
const fs = require('fs')
const path = require('path')
const Hyperlogger = require('../index')
const {
  createLogger,
  captureConsole,
  hrtimeClock,
  severities,
  durationMs,
  bodies,
  readLines,
  stubfs,
  fail
} = require('./helper')

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

test('logger formats errors to show message and code', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'logs')
  const logger = new Hyperlogger({ file, maxBytes: 50 })

  t.teardown(() => logger.close())

  logger.error('failed', new Error('boom'))

  const [log] = await Array.fromAsync(Hyperlogger.readLogs(file))
  t.ok(log.body.includes('failed Error: boom'), 'contains standard error message')
  t.ok(log.body.includes('\n    at '), 'contains a stack trace')
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

test('dev prints to the console regardless of level', async (t) => {
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
      ['info', 'i', { attribute: true }],
      ['warn', 'w'],
      ['error', 'e']
    ],
    'dev at DEBUG: each level goes to its console method'
  )
  t.alike(
    await run({ dev: true, level: 'INFO' }),
    [
      ['info', 'i', { attribute: true }],
      ['warn', 'w'],
      ['error', 'e']
    ],
    'dev at INFO: info and above goes to its console method'
  )
  t.alike(
    await run({ dev: true, level: 'WARN' }),
    [
      ['warn', 'w'],
      ['error', 'e']
    ],
    'dev at WARN: warn and above goes to its console method'
  )
  t.alike(
    await run({ dev: true, level: 'ERROR' }),
    [['error', 'e']],
    'dev at ERROR: error and above goes to its console method'
  )
  t.alike(await run({ dev: false, level: 'DEBUG' }), [], 'dev off: nothing printed')
})

test('dev output gets the same arguments as the call, attributes included', async (t) => {
  const { file, logger } = await createLogger(t, { dev: true })
  const attributes = { roomId: 'abc', count: 2 }

  const printed = captureConsole(() => logger.info('hello', 'world', attributes))

  t.alike(printed, [['info', 'hello', 'world', attributes]], 'the console sees every argument')
  t.is(printed[0][3], attributes, 'the attributes object itself, not a copy')

  const [record] = readLines(file)
  t.is(record.body, 'hello world', 'the file body is the message without the attributes')
  t.alike(
    record.attributes,
    { roomId: 'abc', count: 2 },
    'the file keeps the attributes separately'
  )
})

test('after close, every method is safe to call and nothing more is written', async (t) => {
  const { file, logger } = await createLogger(t, { level: 'DEBUG', verbose: true, dev: true })

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

  // with the first logger closed, a new one can take over the same file
  const next = new Hyperlogger({ file })
  t.teardown(() => next.close())

  next.info('next logger writing')
  t.alike(
    bodies(file),
    ['before close', 'next logger writing'],
    'a new logger picks up where it left off'
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

  const { advance } = hrtimeClock(t)

  logger.time('task')
  advance(50)
  logger.time('task') // restart
  advance(10)
  logger.timeLog('task')

  t.is(durationMs(bodies(file)[0]), 10, 'measured from the restart, not the first call')
})

test('timeLog keeps the timer running', async (t) => {
  const { file, logger } = await createLogger(t)
  const { advance } = hrtimeClock(t)

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
  const { advance } = hrtimeClock(t)

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

test('parseLogs only returns JSON objects, skipping blank, invalid and non-object lines', (t) => {
  t.alike(Hyperlogger.parseLogs('\n{"a":1}\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }])
  t.alike(Hyperlogger.parseLogs('{"a":1}\nnot json\n'), [{ a: 1 }])
  t.alike(Hyperlogger.parseLogs('{"a":1}\n42\n"text"\n[1, 2]\nnull\ntrue\n{"b":2}'), [
    { a: 1 },
    { b: 2 }
  ])
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

test('readLogs streams every record, oldest first, across the rotated files', async (t) => {
  const { file, logger } = await createLogger(t, { maxTotalSize: 10 * 400 }) // about 3 lines per file

  for (let i = 0; i < 12; i++) logger.info(`line ${i}`)
  t.ok(fs.existsSync(`${file}.1`), 'the records are spread across rotated files')

  const stream = Hyperlogger.readLogs(file)
  t.absent(Array.isArray(stream), 'not an array')
  t.is(typeof stream[Symbol.asyncIterator], 'function', 'can be used with for await')

  const records = []
  for await (const record of stream) records.push(record.body)

  t.alike(
    records,
    Array.from({ length: 12 }, (_, i) => `line ${i}`),
    'every record, in the order written'
  )
})

test('readLogs can be stopped early', async (t) => {
  const { file, logger } = await createLogger(t, { maxTotalSize: 10 * 400 })

  for (let i = 0; i < 12; i++) logger.info(`line ${i}`)

  const stream = Hyperlogger.readLogs(file)
  const records = []
  for await (const record of stream) {
    records.push(record.body)
    if (records.length === 3) break
  }

  t.alike(records, ['line 0', 'line 1', 'line 2'], 'the first records, oldest first')
  t.ok(stream.destroyed, 'breaking out of the loop closes the stream')
})

test('readLogs reads the files as they were when reading started', async (t) => {
  const { file, logger } = await createLogger(t, { maxTotalSize: 10 * 400 })

  for (let i = 0; i < 12; i++) logger.info(`line ${i}`)

  const records = []
  for await (const record of Hyperlogger.readLogs(file)) {
    records.push(record.body)

    // once reading has started, keep logging: the files rotate (and the oldest are
    // deleted) underneath the stream
    if (records.length === 1) {
      for (let i = 12; i < 60; i++) logger.info(`line ${i}`)
    }
  }

  t.alike(
    records,
    Array.from({ length: 12 }, (_, i) => `line ${i}`),
    'exactly the records that existed when reading started, nothing skipped or repeated'
  )
})

test('readLogs on a file that does not exist gives no records', async (t) => {
  const dir = await t.tmp()

  t.alike(await Array.fromAsync(Hyperlogger.readLogs(path.join(dir, 'missing.log'))), [])
})

test('readLogs returns lines of any length whole, including around the read size', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'app.log')
  const CHUNK = 65_536

  const line = (total, char = 'x') => JSON.stringify({ body: char.repeat(total - 12) }) + '\n'
  const lines = [
    line(200_000),
    line(20),
    line(CHUNK - 1),
    line(CHUNK),
    line(CHUNK + 1),
    line(20),
    JSON.stringify({ body: 'é😀'.repeat(40_000) }) + '\n',
    JSON.stringify({ body: 'y'.repeat(70_000) })
  ]
  fs.writeFileSync(file, lines.join(''))

  const records = await Array.fromAsync(Hyperlogger.readLogs(file))
  t.alike(
    records.map((record) => record.body),
    lines.map((l) => JSON.parse(l).body),
    'every line comes back whole and in order'
  )
})

test('readLogs only returns JSON objects', async (t) => {
  const dir = await t.tmp()
  const file = path.join(dir, 'app.log')

  fs.writeFileSync(
    file,
    [
      '{"body":"first"}',
      '42',
      '"text"',
      '[1, 2]',
      'null',
      'true',
      'not json at all',
      '',
      '{"body":"half writt',
      '{"body":"last"}'
    ].join('\n') + '\n'
  )

  const records = await Array.fromAsync(Hyperlogger.readLogs(file))
  t.alike(
    records,
    [{ body: 'first' }, { body: 'last' }],
    'everything that is not a JSON object is skipped'
  )
})

test('readLogs fails if a log file cannot be read, and closes every file', async (t) => {
  const { file, logger } = await createLogger(t, { maxTotalSize: 10 * 400 })
  for (let i = 0; i < 12; i++) logger.info(`line ${i}`)
  logger.close()

  let open = 0
  const openSync = stubfs(t, 'openSync', (target, ...args) => {
    if (target === `${file}.1`) fail('EACCES')()
    const fd = openSync(target, ...args)
    open++
    return fd
  })
  const closeSync = stubfs(t, 'closeSync', (fd) => {
    open--
    return closeSync(fd)
  })

  const records = []
  await t.exception(async () => {
    for await (const record of Hyperlogger.readLogs(file)) records.push(record)
  }, /EACCES/)

  t.alike(records, [], 'files are opened before any record is read, so none were handed out')
  t.is(open, 0, 'the files opened before the failure were closed')
})

test('readLogs closes the file if reading its size fails', async (t) => {
  const { file, logger } = await createLogger(t, { maxTotalSize: 10 * 400 })
  for (let i = 0; i < 12; i++) logger.info(`line ${i}`)
  logger.close()

  let open = 0
  const openSync = stubfs(t, 'openSync', (...args) => {
    const fd = openSync(...args)
    open++
    return fd
  })
  const closeSync = stubfs(t, 'closeSync', (fd) => {
    open--
    return closeSync(fd)
  })
  stubfs(t, 'fstatSync', fail('EIO'))

  await t.exception(async () => {
    for await (const record of Hyperlogger.readLogs(file)) {
      t.fail('no record expected: ' + record.body)
    }
  }, /EIO/)

  t.is(open, 0, 'the file whose size could not be read was closed too')
})

test("if readLogs fails on a read error partway through, prior file's records will still have been provided", async (t) => {
  const { file, logger } = await createLogger(t, { maxTotalSize: 10 * 400 })
  for (let i = 0; i < 12; i++) logger.info(`line ${i}`)
  logger.close()

  const oldest = fs
    .readdirSync(path.dirname(file))
    .map((name) => path.join(path.dirname(file), name))
    .sort()
    .reverse()[0]
  const firstFile = readLines(oldest).map((record) => record.body)
  t.ok(firstFile.length > 0 && oldest !== file, 'the logs span more than one file')

  const opened = []
  let open = 0
  const openSync = stubfs(t, 'openSync', (...args) => {
    const fd = openSync(...args)
    opened.push(fd)
    open++
    return fd
  })
  const closeSync = stubfs(t, 'closeSync', (fd) => {
    open--
    return closeSync(fd)
  })

  // reading the second file fails
  const readSync = stubfs(t, 'readSync', (fd, ...args) => {
    if (fd === opened[1]) fail('EIO')()
    return readSync(fd, ...args)
  })

  const records = []
  await t.exception(
    async () => {
      for await (const record of Hyperlogger.readLogs(file)) records.push(record.body)
    },
    /EIO/,
    'the loop throws the read error'
  )

  t.alike(records, firstFile, 'every record from the first file was handed out before the error')
  t.is(open, 0, 'every file was closed')
})
