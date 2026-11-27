# Hyperlogger

A small logger for Node.js and Bare, with structured JSON file output, log levels, labelled timers and size-limited log rotation.

Bare also writes messages to the native system logger. In Node.js, the system logger is a no-op; use file logging or enable the development console output.

## Install

```sh
npm install hyperlogger
```

## Usage

```js
const Hyperlogger = require('hyperlogger')

const logger = new Hyperlogger({
  file: './app.log',
  level: 'DEBUG'
})

logger.info('Starting download', { file: 'example.txt' })

logger.time('download')
// Perform the download...
logger.timeEnd('download', { file: 'example.txt' })

logger.close()
```

## API

#### `const logger = new Hyperlogger([options])`

Create a logger. Options include:

```js
{
  level: 'INFO', // minimum severity: 'DEBUG', 'INFO', 'WARN' or 'ERROR'
  file: undefined, // optional path for newline-delimited JSON logs
  maxTotalSize: 104_857_600, // bytes across the log file and its rotated copies
  maxDepth: 6, // how deeply attributes are normalised (at most 100)
  maxBytes: 262_144, // approximate size budget for one record's attributes (at most 2 MiB)
  dev: false, // also print each logged message to the console
  verbose: false // enable verboseDebug and verboseInfo
}
```

`level` must be one of the names above, in capitals; anything else throws a `RangeError`. `maxTotalSize`, if given, must be a number of at least 10. `maxDepth` must be a whole number from 1 to 100, and `maxBytes` a whole number from 1 to 2 MiB (2,097,152). Anything else throws a `RangeError`; nothing is silently adjusted. Leaving an option out uses its default.

Without `file`, no file is written. In Node.js, without development console output or a log file, logging produces no output.

The folder for `file` must already exist; the logger creates the file but not its folder, and throws if the folder is missing.

#### `logger.debug(...args)`

#### `logger.info(...args)`

#### `logger.warn(...args)`

#### `logger.error(...args)`

Log a message at the corresponding severity. Messages below `level` are ignored.

Each argument is formatted the way `console.log` would show it on its own, and the results are joined with spaces to form the message. Strings are used as they are, objects are shown as an inspected preview, and errors include their stack trace. Placeholders such as `%s` and `%d` are not substituted.

A final plain object is treated as structured attributes and stored separately in the file output. Attributes are not sent to the system logger.

```js
logger.info('Connected to', 'peer', { peerId: 'abc' })
logger.error('Download failed', err) // the message includes err's stack trace
```

File records contain `timeUnixNano`, `observedTimeUnixNano`, `severityNumber`, `severityText`, `body` and `attributes`. Timestamps are epoch nanoseconds encoded as decimal strings, with millisecond precision.

#### Attributes

Attributes are copied into JSON-safe values; the object passed in is never changed.

- Dates become ISO strings, and bigints, symbols and non-finite numbers become strings such as `'42'`, `'Symbol(id)'` and `'NaN'`. `undefined` and functions become `'[Undefined]'` and `'[Function]'`.
- Errors become `{ name, message, stack }`, plus `code` when the error has one.
- Plain objects and arrays are copied. Instances of other classes become `'[Unsupported object]'`.
- Maps, Sets and binary values become console-style previews, limited to 32 entries or bytes.
- Circular references become `'[Circular]'`, values nested deeper than `maxDepth` become `'[MaxDepth]'`, and getters that throw become `'[Unserializable]'`.

Large values are cut down, with a marker saying how much was left out:

- Strings longer than 10,000 characters keep their start, followed by `'... N more characters'`.
- Arrays keep their first 100 entries, followed by `'... N more items'`.
- Once a record's attributes reach `maxBytes`, the remaining array entries are replaced by `'... N more items'` and the remaining object keys by a `'...': 'N more keys'` entry.

The size is estimated while the attributes are copied, so a record can end up somewhat over `maxBytes`, mainly with text that needs escaping or uses multi-byte characters.

#### `logger.verboseDebug(...args)`

#### `logger.verboseInfo(...args)`

Log only when `verbose` is enabled. The usual severity filtering still applies.

#### `logger.time(label)`

Start a timer, replacing any existing timer with the same label.

#### `logger.timeLog(label, ...args)`

Log the elapsed time at INFO severity, followed by any additional message arguments and attributes. Keeps the timer running.

#### `logger.timeEnd(label, ...args)`

Log the elapsed time and remove the timer. Durations are formatted in milliseconds or seconds. Unknown timer labels are ignored.

#### `logger.mute()`

#### `logger.unmute()`

Disable or restore all logging output.

#### `logger.close()`

Stop logging and close the file. Later calls on this logger are ignored. Calling `close` more than once is safe. Once a logger is closed, a new logger can use the same `file`.

#### `const stream = Hyperlogger.readLogs(file)`

A [streamx](https://github.com/mafintosh/streamx) readable stream of every record from a log file and its rotated copies, oldest first: `file.9` down to `file.1`, then `file` itself. Missing files are skipped. Only JSON objects are returned: lines that aren't valid JSON, or are JSON but not an object, are skipped. Reading does not need, or create, a logger.

```js
for await (const record of Hyperlogger.readLogs('./app.log')) {
  console.log(record.severityText, record.body)
}
```

The files are read as they were when reading started: records written while the stream is being read, including any rotation they cause, are not included.

If any of the files exists but can't be read, the stream fails with that error, so a `for await` loop throws it. A file that can't be opened fails the read before any records are returned; an error while reading a file can come after some records have already been returned.

Breaking out of the loop early closes the stream and its files. A stream that has started reading keeps all its files open until it is read to the end, broken out of, or destroyed, so always do one of those. To collect everything into an array, use `await Array.fromAsync(Hyperlogger.readLogs('./app.log'))`.

**Memory.** Records are read one line at a time, so memory use stays small however large the logs are, as long as individual lines are. Each record's attributes are limited to roughly `maxBytes` (256 KiB by default), so lines are normally around that size or smaller. Message bodies are not limited, though: a very long message makes an equally long line, which is held in memory while it's read.

#### `const logs = Hyperlogger.parseLogs(rawLogs)`

Parse log text you already have, such as lines received from elsewhere, into an array of records. Only JSON objects are returned: empty lines, lines that aren't valid JSON, and JSON that isn't an object are skipped, the same as `readLogs`.

To read log files, use `readLogs` instead: it streams them rather than loading them into memory.

```js
const logs = Hyperlogger.parseLogs(text)
```

#### `Hyperlogger.LEVELS`

Severity numbers: `DEBUG: 5`, `INFO: 9`, `WARN: 13`, `ERROR: 17`.

## Log files and rotation

Records are appended to `file` as one JSON object per line. Writes are synchronous, so a record is in the file as soon as the logging call returns.

`maxTotalSize` is shared between the live file and up to 9 older copies, so each file holds about a tenth of it (10 MiB each by default). When the live file goes over its share, it becomes `file.1`, the older copies move up one (`file.1` to `file.2`, and so on), and a new live file is started. When all 9 older copies exist, the oldest is deleted to make room.

If rotation fails, for example because another program has the file open on Windows or the folder has become read-only, the logger keeps appending to the live file and tries again later. No records are lost; the live file grows past its share until rotation succeeds. If the file cannot be reopened at all, records are dropped until it can, and reopening is retried periodically.

A rotation interrupted part way, for example by a crash, can leave a `file.rotating` copy behind. It is moved into the older copies on the next rotation or the next start.

Use one logger per file, and pass it around rather than creating another logger on the same `file`: two loggers writing the same file, in one process or several, rotate it out from under each other.

## License

Apache-2.0
