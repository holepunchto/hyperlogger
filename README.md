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
  dev: false, // also print messages to the console when level is DEBUG
  verbose: false // enable verboseDebug and verboseInfo
}
```

`level` must be one of the names above, in capitals; anything else throws a `RangeError`.

Without `file`, no file is written. In Node.js, without development console output or a log file, logging produces no output.

The folder for `file` must already exist; the logger creates the file but not its folder, and throws if the folder is missing.

#### `logger.debug(...args)`

#### `logger.info(...args)`

#### `logger.warn(...args)`

#### `logger.error(...args)`

Log a message at the corresponding severity. Messages below `level` are ignored.

Each argument is formatted the way `console.log` would show it on its own, using `util.format` in Node.js and `bare-format` in Bare, and the results are joined with spaces to form the message. Strings are used as they are, objects are shown as an inspected preview, and errors include their stack trace. Placeholders such as `%s` and `%d` are not substituted.

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

Stop logging. Later calls on this logger are ignored. Calling `close` more than once is safe.

Loggers in the same process that use the same `file` share one open file, which is closed when the last of them closes.

#### `const logs = Hyperlogger.readLogs(file)`

Read every record from a log file and its rotated copies, oldest first: `file.9` down to `file.1`, then `file` itself. Missing files are skipped. Reading does not need, or create, a logger.

```js
const logs = Hyperlogger.readLogs('./app.log')
```

#### `const logs = Hyperlogger.parseLogs(rawLogs)`

Parse a newline-delimited JSON log string into an array of records. Empty lines are ignored; invalid JSON throws.

```js
const logs = Hyperlogger.parseLogs(fs.readFileSync('./app.log', 'utf8'))
```

#### `Hyperlogger.LEVELS`

Severity numbers: `DEBUG: 5`, `INFO: 9`, `WARN: 13`, `ERROR: 17`.

## Log files and rotation

Records are appended to `file` as one JSON object per line. Writes are synchronous, so a record is in the file as soon as the logging call returns.

`maxTotalSize` is shared between the live file and up to 9 older copies, so each file holds about a tenth of it (10 MiB each by default). When the live file goes over its share, it becomes `file.1`, the older copies move up one (`file.1` to `file.2`, and so on), and a new live file is started. When all 9 older copies exist, the oldest is deleted to make room.

If rotation fails, for example because another program has the file open on Windows or the folder has become read-only, the logger keeps appending to the live file and tries again at most once a second. No records are lost; the live file grows past its share until rotation succeeds. If the file cannot be reopened at all, records are dropped until it can, and reopening is retried at most once a second.

A rotation interrupted part way, for example by a crash, can leave a `file.rotating` copy behind. It is moved into the older copies on the next rotation or the next start.

Loggers in the same process that use the same `file` share one writer, so they never rotate the file out from under each other. Separate processes should each use their own `file`.

## License

Apache-2.0
