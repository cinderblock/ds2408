/**
 * Maxim/Dallas DS2408 — 8-channel 1-Wire I/O — accessed via the Linux
 * `w1-gpio` / `w1-therm` kernel driver and its sysfs interface.
 *
 * Devices appear under `/sys/bus/w1/devices/29-<serial>/` with these files:
 *
 * | file               | description                                          |
 * | ------------------ | ---------------------------------------------------- |
 * | `state`            | live PIO pin levels                                  |
 * | `output`           | current PIO output latches                           |
 * | `activity`         | edge-detect flags (read-clear)                       |
 * | `status_control`   | feature byte (PLS / CT / ROS / PORL)                 |
 * | `cond_search_mask` | conditional-search mask                              |
 * | `cond_search_polarity` | conditional-search polarity                      |
 *
 * Each read/write is a single byte. Reads can race with internal device state
 * changes, so this library reads each value multiple times and only returns a
 * value once it stabilises (see `verificationLoops`).
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Root sysfs path where the 1-Wire bus exposes attached devices. */
const W1_DEVICES_DIR = '/sys/bus/w1/devices';

/** DS2408 1-Wire family code. Every DS2408 serial starts with `29-`. */
const DS2408_FAMILY_PREFIX = '29-';

/** All sysfs files exposed by the DS2408 kernel driver. */
const DEVICE_FILES = [
  'activity',
  'cond_search_mask',
  'cond_search_polarity',
  'output',
  'state',
  'status_control',
] as const;
type DeviceFile = (typeof DEVICE_FILES)[number];

/** Writeable sysfs files. `activity` is also writeable (write-to-clear). */
type WriteableFile = 'activity' | 'output' | 'status_control';

export interface DS2408Options {
  /**
   * Number of consecutive identical reads required before a value is
   * considered stable. Defaults to 2 (i.e. 3 reads in a row must agree).
   */
  verificationLoops?: number;
  /**
   * Override of the sysfs root, useful for tests. Defaults to
   * `/sys/bus/w1/devices`.
   */
  devicesDir?: string;
}

export interface ActivityLoopOptions {
  /**
   * Milliseconds to wait between activity polls. Defaults to 100.
   */
  loopDelay?: number;
}

/**
 * Called for every activity tick where the activity byte was non-zero.
 *
 * @param activity 8-bit bitmap of channels that registered an edge since the
 *   last read. The byte is read-cleared by the driver.
 * @param state 8-bit live pin levels at the time the activity byte was read.
 */
export type ActivityListener = (activity: number, state: number) => void;

/** Returned by `onActivity()`; call it to detach the listener. */
export type RemoveListener = () => void;

/**
 * Per-bit flags written to the `status_control` register.
 *
 * Names follow the DS2408 datasheet: PLS, CT, ROS, PORL.
 */
export interface StatusControlBits {
  /**
   * **P**IO **L**atch **S**elect. When true, the conditional search compares
   * against PIO activity latches instead of live PIO state.
   */
  PLS?: boolean;
  /**
   * **C**ondition search **T**ype. When true, conditional search requires
   * *all* selected channels to match (AND). When false, *any* match (OR).
   */
  CT?: boolean;
  /**
   * **R**eset **O**n **S**trobe. When true, the RSTZ pin becomes a strobe
   * output instead of a reset input. Strobe mode requires an external
   * pull-up on the pin.
   */
  ROS?: boolean;
  /**
   * **P**ower-**O**n **R**eset **L**atch. Always written as `false` (or
   * omitted) to clear the power-on-reset indicator after reading it.
   */
  PORL?: false;
}

const STATUS_CONTROL_BIT_INDEX: Record<keyof StatusControlBits, number> = {
  PLS: 0,
  CT: 1,
  ROS: 2,
  PORL: 3,
};

/** Set `bit` of `x` to `value`; leave it alone if `value` is undefined. */
function applyBit(x: number, bit: number, value: boolean | undefined): number {
  if (value === undefined) return x;
  const mask = 1 << bit;
  return value ? x | mask : x & ~mask;
}

/**
 * List the serials of all DS2408 chips currently visible on the 1-Wire bus.
 *
 * @param devicesDir sysfs root; defaults to `/sys/bus/w1/devices`.
 */
export async function findAttachedDevices(
  devicesDir: string = W1_DEVICES_DIR,
): Promise<string[]> {
  const entries = await readdir(devicesDir);
  return entries.filter(name => name.startsWith(DS2408_FAMILY_PREFIX));
}

/**
 * Driver for a single DS2408 chip.
 *
 * Construct with `await DS2408.open(serial?, options?)`. The constructor is
 * private so the initial `output`-register read can complete before the
 * instance is exposed.
 */
export class DS2408 {
  /** Cached value of the output-latch register. */
  private outputs = 0xff;

  /** Listeners registered via `onActivity()`. */
  private readonly activityListeners = new Set<ActivityListener>();

  /** Handle of the in-flight activity-loop timer, when running. */
  private activityTimer: NodeJS.Timeout | undefined = undefined;

  /** Set to true while a tick is in progress so stopActivityLoop can await it. */
  private activityTickInFlight = false;

  /** Listeners attached to the activity loop's final-tick boundary. */
  private readonly activityLoopStopListeners = new Set<() => void>();

  /** Marker that stopActivityLoop has been called; tells the in-flight tick to bail. */
  private activityLoopStopRequested = false;

  private constructor(
    /** 1-Wire serial of the chip, e.g. `29-0000017d3b86`. */
    public readonly serial: string,
    private readonly devicesDir: string,
    private readonly verificationLoops: number,
  ) {}

  /**
   * Open a DS2408. If `serial` is omitted, the first attached DS2408 is used.
   * Reads the current output-latch register before returning so the instance
   * is internally consistent.
   */
  static async open(
    serial?: string,
    options: DS2408Options = {},
  ): Promise<DS2408> {
    const devicesDir = options.devicesDir ?? W1_DEVICES_DIR;
    const verificationLoops = options.verificationLoops ?? 2;

    if (serial === undefined) {
      const attached = await findAttachedDevices(devicesDir);
      const first = attached[0];
      if (first === undefined) {
        throw new Error('No DS2408 devices found on the 1-Wire bus');
      }
      serial = first;
    } else if (!serial.startsWith(DS2408_FAMILY_PREFIX)) {
      throw new Error(
        `DS2408 serials start with "${DS2408_FAMILY_PREFIX}", got "${serial}"`,
      );
    }

    const ds = new DS2408(serial, devicesDir, verificationLoops);
    ds.outputs = await ds.readOutput();
    return ds;
  }

  private deviceFile(filename: string): string {
    return join(this.devicesDir, this.serial, filename);
  }

  private async readDeviceFileOnce(filename: DeviceFile): Promise<number> {
    const buf = await readFile(this.deviceFile(filename));
    return buf.readUInt8(0);
  }

  /**
   * Read a sysfs file repeatedly until the value is stable across
   * `verificationLoops + 1` consecutive reads. Without this, you'll see the
   * occasional transient mid-update value.
   */
  private async readDeviceFile(filename: DeviceFile): Promise<number> {
    let last = await this.readDeviceFileOnce(filename);
    let matches = 0;
    while (matches < this.verificationLoops) {
      const next = await this.readDeviceFileOnce(filename);
      if (next === last) {
        matches++;
      } else {
        last = next;
        matches = 0;
      }
    }
    return last;
  }

  private async writeDeviceFile(
    filename: WriteableFile,
    value: number = 0,
  ): Promise<void> {
    // `activity` only takes a 1-byte write; its contents are ignored.
    const buf = Buffer.allocUnsafe(1);
    buf.writeUInt8(value & 0xff, 0);
    await writeFile(this.deviceFile(filename), buf);
  }

  /** Live PIO pin levels. */
  readState(): Promise<number> {
    return this.readDeviceFile('state');
  }

  /** Current PIO output-latch register. */
  async readOutput(): Promise<number> {
    const v = await this.readDeviceFile('output');
    this.outputs = v;
    return v;
  }

  /** Current `status_control` byte. */
  readControl(): Promise<number> {
    return this.readDeviceFile('status_control');
  }

  /** Conditional-search mask register. */
  readCondSearchMask(): Promise<number> {
    return this.readDeviceFile('cond_search_mask');
  }

  /** Conditional-search polarity register. */
  readCondSearchPolarity(): Promise<number> {
    return this.readDeviceFile('cond_search_polarity');
  }

  /** Write the entire `status_control` register. */
  setControl(value: number): Promise<void> {
    return this.writeDeviceFile('status_control', value);
  }

  /**
   * Update individual `status_control` bits.
   *
   * @param bits which bits to touch — omitted bits are left alone (if `read`
   *   is true, the default) or zeroed (if `read` is false).
   * @param read if true, read the current register first and modify only the
   *   specified bits. If false, write a value with all unspecified bits as 0.
   */
  async setControls(bits: StatusControlBits, read = true): Promise<void> {
    let next = read ? await this.readControl() : 0;
    for (const key of Object.keys(STATUS_CONTROL_BIT_INDEX) as Array<
      keyof StatusControlBits
    >) {
      next = applyBit(next, STATUS_CONTROL_BIT_INDEX[key], bits[key]);
    }
    await this.setControl(next);
  }

  /**
   * Write the entire output-latch byte. Bits set to `0` sink the pin (drive
   * low); bits set to `1` float (open-drain releases the pin so an external
   * pull-up wins).
   */
  async setOutput(byte: number): Promise<void> {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new RangeError(
        `Output value must be an integer in [0, 255]; got ${byte}`,
      );
    }
    await this.writeDeviceFile('output', byte);
    this.outputs = byte;
  }

  /**
   * Clear (drive low / sink) the bits in `mask`. Other bits stay where they
   * were, based on the cached output state.
   */
  sinkOutputs(mask: number): Promise<void> {
    return this.setOutput(this.outputs & ~mask & 0xff);
  }

  /**
   * Set (float / release) the bits in `mask`. Other bits stay where they
   * were, based on the cached output state.
   */
  floatOutputs(mask: number): Promise<void> {
    return this.setOutput((this.outputs | mask) & 0xff);
  }

  /**
   * Set bits in `mask` to the corresponding bits of `value`; leave all other
   * bits alone (based on the cached output state).
   */
  maskedSetOutputs(mask: number, value: number): Promise<void> {
    return this.setOutput(((this.outputs & ~mask) | (value & mask)) & 0xff);
  }

  /**
   * Read the activity byte, then write-to-clear it. Returns the activity byte
   * and the live `state` byte (read after the activity-clear).
   */
  async pollActivity(): Promise<{ activity: number; state: number }> {
    const activity = await this.readDeviceFile('activity');
    if (activity === 0) {
      return { activity, state: await this.readState() };
    }
    await this.writeDeviceFile('activity');
    const state = await this.readState();
    return { activity, state };
  }

  /**
   * Register a listener that fires whenever the activity loop sees a non-zero
   * activity byte. Returns a removal function.
   */
  onActivity(listener: ActivityListener): RemoveListener {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  /** True while the activity loop is running. */
  get isActivityLoopRunning(): boolean {
    return this.activityTimer !== undefined || this.activityTickInFlight;
  }

  /**
   * Start polling the device's activity register on a timer. Each tick that
   * sees a non-zero activity byte notifies all `onActivity()` listeners.
   *
   * Idempotent — calling it again while running is a no-op.
   *
   * @param options.loopDelay milliseconds between polls (default 100).
   */
  startActivityLoop(options: ActivityLoopOptions = {}): void {
    if (this.activityTimer !== undefined) return;
    const delay = options.loopDelay ?? 100;
    this.activityLoopStopRequested = false;

    const tick = async (): Promise<void> => {
      this.activityTimer = undefined;
      if (this.activityLoopStopRequested) {
        this.fireLoopStopped();
        return;
      }
      this.activityTickInFlight = true;
      try {
        const { activity, state } = await this.pollActivity();
        if (activity !== 0) {
          for (const listener of this.activityListeners) {
            listener(activity, state);
          }
        }
      } catch (err) {
        // Surface errors via a microtask so they aren't silently swallowed.
        // Stops the loop on error — the caller can restart after handling it.
        this.activityTickInFlight = false;
        this.fireLoopStopped();
        queueMicrotask(() => {
          throw err;
        });
        return;
      }
      this.activityTickInFlight = false;
      if (this.activityLoopStopRequested) {
        this.fireLoopStopped();
        return;
      }
      this.activityTimer = setTimeout(tick, delay);
    };

    this.activityTimer = setTimeout(tick, 0);
  }

  private fireLoopStopped(): void {
    this.activityLoopStopRequested = false;
    const listeners = Array.from(this.activityLoopStopListeners);
    this.activityLoopStopListeners.clear();
    for (const listener of listeners) listener();
  }

  /**
   * Stop the activity loop and resolve once the in-flight iteration (if any)
   * has finished. Idempotent.
   */
  stopActivityLoop(): Promise<void> {
    if (!this.isActivityLoopRunning) return Promise.resolve();
    this.activityLoopStopRequested = true;
    if (this.activityTimer !== undefined) {
      clearTimeout(this.activityTimer);
      this.activityTimer = undefined;
    }
    return new Promise<void>(resolve => {
      if (!this.activityTickInFlight) {
        resolve();
        return;
      }
      this.activityLoopStopListeners.add(resolve);
    });
  }
}

export default DS2408;
