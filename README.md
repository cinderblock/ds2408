# ds2408

DS2408 1-Wire 8-channel I/O chip driver for Node.js, using the Linux kernel's `w1-gpio` / `w1-therm` sysfs interface.

[![npm](https://img.shields.io/npm/v/ds2408.svg)](https://www.npmjs.com/package/ds2408)
[![CI](https://github.com/cinderblock/ds2408/actions/workflows/ci.yml/badge.svg)](https://github.com/cinderblock/ds2408/actions/workflows/ci.yml)

- Zero runtime dependencies
- ESM, TypeScript types
- Node 22+

## Requirements

- Linux host with the 1-Wire kernel modules loaded (`w1-gpio`, `wire`).
- DS2408 attached on the 1-Wire bus, exposed under `/sys/bus/w1/devices/29-*`.
- Process needs read/write access to those sysfs files (usually root, or a `udev` rule).

## Install

```bash
npm install ds2408
```

## Usage

```ts
import { DS2408, findAttachedDevices } from 'ds2408';

// Auto-select the first attached DS2408.
const ds = await DS2408.open();

// Or pass an explicit serial.
// const ds = await DS2408.open('29-0000017d3b86');

// Read live pin levels.
console.log('state:', (await ds.readState()).toString(2).padStart(8, '0'));

// Drive specific bits low (sink), float others (release to external pull-up).
await ds.sinkOutputs(0b0000_0011);  // channels 0 and 1 sink
await ds.floatOutputs(0b1111_1100); // channels 2..7 float

// Read the current output latch.
console.log('output:', await ds.readOutput());

// React to edges on input pins.
const off = ds.onActivity((activity, state) => {
  console.log(`activity=${activity.toString(2)} state=${state.toString(2)}`);
});
ds.startActivityLoop({ loopDelay: 50 });

// Later …
await ds.stopActivityLoop();
off(); // detach the listener
```

## API

### `DS2408.open(serial?, options?)`

Async factory. Reads the current output-latch register before returning so the instance is consistent.

| option              | type   | default                       | description                                                |
| ------------------- | ------ | ----------------------------- | ---------------------------------------------------------- |
| `verificationLoops` | number | `2`                           | Consecutive identical reads needed before returning a value. Filters transient mid-update values. |
| `devicesDir`        | string | `/sys/bus/w1/devices`         | Sysfs root. Override for tests.                            |

### `findAttachedDevices(devicesDir?)`

Returns the serial numbers of all DS2408 chips currently on the bus.

### Reading

- `readState()` — live PIO pin levels (1 = high, 0 = low).
- `readOutput()` — current output-latch register (and updates the internal cache).
- `readControl()` — `status_control` byte.
- `readCondSearchMask()` / `readCondSearchPolarity()` — conditional-search registers.
- `pollActivity()` — read & write-clear the activity byte; returns `{ activity, state }`.

### Writing

- `setOutput(byte)` — write the entire output-latch byte (0..255). Bits set to `0` sink the pin; bits set to `1` float it.
- `sinkOutputs(mask)` / `floatOutputs(mask)` / `maskedSetOutputs(mask, value)` — manipulate outputs relative to the cached state.
- `setControl(byte)` / `setControls({ PLS, CT, ROS, PORL }, read = true)` — write the status-control byte. `setControls` modifies only the bits you specify (when `read = true`).

### Activity loop

- `startActivityLoop({ loopDelay = 100 })` — start polling the activity register on a timer; non-zero readings notify all `onActivity` listeners.
- `stopActivityLoop()` — stop the loop; resolves once the in-flight tick (if any) finishes.
- `onActivity(listener)` — register a listener; returns a removal function.
- `isActivityLoopRunning` — true while the loop is active.

## License

MIT — see [LICENSE](./LICENSE).
