import { promises as fsPromise, readdirSync } from 'fs';
import { join } from 'path';

export function onAttach(listener: (serial: string) => void) {
  console.log('Unimplemented');

  return () => {
    console.log('Unimplemented remove onAttach listener');
  };
}

export type ActivityListener = (activity: number, state: number) => void;

const devicesDir = '/sys/bus/w1/devices';

/**
 * Sets a bit in a number to a value, unless the value is undefined.
 * @param x The number to modify
 * @param bit bit number in the number
 * @param value value to set to
 */
function setBit(x: number, bit: number, value: boolean | undefined) {
  if (value === undefined) return x;
  bit = 1 << bit;
  if (value) return x | bit;
  return x & ~bit;
}

export default class DS2408 {
  readonly serial: string;
  private verificationLoops: number;
  private outputs: number;
  private activityListeners: ActivityListener[];

  constructor(serial?: string, loopDelay = 100, verificationLoops = 2) {
    if (!serial) {
      serial = readdirSync(devicesDir).find(s => s.startsWith('29-'));
      if (!serial) throw new Error('Did not find any attached DS2408 devices');
      console.log('Automatically detected first DS2408 device serial:', serial);
    } else if (!serial.startsWith('29-')) {
      throw new Error('DS2408 serial numbers start with `29-`');
    }

    this.serial = serial;
    this.verificationLoops = verificationLoops;
    this.activityListeners = [];

    this.outputs = 255;
    this.readOutput();

    const activityLoop = async () => {
      try {
        await this.updateActivity();
        setTimeout(activityLoop, loopDelay);
      } catch (e) {
        console.log('Error!', e);
      }
    };

    setImmediate(activityLoop);
  }

  private deviceFile(...filenames: string[]) {
    return join(devicesDir, this.serial, ...filenames);
  }

  private async readDeviceFileOnce(
    filename:
      | 'activity'
      | 'cond_search_mask'
      | 'cond_search_polarity'
      | 'output'
      | 'state'
      | 'status_control'
  ) {
    return (await fsPromise.readFile(this.deviceFile(filename))).readUInt8(0);
  }

  private async readDeviceFile(
    filename:
      | 'activity'
      | 'cond_search_mask'
      | 'cond_search_polarity'
      | 'output'
      | 'state'
      | 'status_control'
  ) {
    let last: number;
    let matches: number;
    do {
      const next = await this.readDeviceFileOnce(filename);
      if (next === last!) {
        matches!++;
      } else {
        matches = 0;
        last = next;
      }
    } while (matches < this.verificationLoops);

    return last;
  }

  private async writeDeviceFile(
    filename: 'output' | 'status_control',
    value: number
  ): Promise<void>;
  private async writeDeviceFile(filename: 'activity'): Promise<void>;
  private async writeDeviceFile(
    filename: 'activity' | 'output' | 'status_control',
    value?: number
  ) {
    return fsPromise.writeFile(
      this.deviceFile(filename),
      // Even though activity doesn't take any data, it requires length to be 1
      Buffer.allocUnsafe(1).fill(filename === 'activity' ? 0 : value)
    );
  }

  /**
   * The current state of the IO pins of the device
   */
  async readState() {
    return this.readDeviceFile('state');
  }

  /**
   * Current status_control byte
   */
  async readControl() {
    return this.readDeviceFile('status_control');
  }

  /**
   * Current Output values
   */
  async readOutput() {
    const ret = this.readDeviceFile('output');

    ret.then(v => (this.outputs = v));

    return ret;
  }

  async setControl(value: number) {
    return this.writeDeviceFile('status_control', value);
  }

  async setControls(
    {
      PLS,
      CT,
      ROS,
      PORL,
    }: {
      /**
     * Selects the PIO activity latches as input for the
conditional search.
     */
      PLS?: boolean;
      /**
       * Select if all selected Condition Search channels are required
       */
      CT?: boolean;
      /**
       * Use Strobe output.
       *
       * Default *requires* a pull up on the pin for proper operation
       */
      ROS?: boolean;
      /**
       * Clear power on reset (false)
       */
      PORL?: false;
    },
    read = true
  ) {
    let next = read ? await this.readControl() : 0;
    next = setBit(next, 0, PLS);
    next = setBit(next, 1, CT);
    next = setBit(next, 2, ROS);
    next = setBit(next, 3, PORL);

    return this.setControl(next);
  }

  private clearActivity() {
    return this.writeDeviceFile('activity');
  }

  private async readActivity() {
    return this.readDeviceFile('activity');
  }

  /**
   * Check the activity byte of the remote device and notify.
   */
  async updateActivity() {
    const a = await this.readActivity().catch(e =>
      console.log('Error in readActivity:', e)
    );
    if (!a) return;

    await this.clearActivity().catch(e =>
      console.log('Error in clearActivity:', e)
    );

    const s = await this.readState();

    this.activityListeners.forEach(l => l(a, s));
  }

  /**
   * Listen for GPIO state changes on remote device
   * @param listener Function to call on activity
   */
  onActivity(listener: ActivityListener) {
    this.activityListeners.push(listener);

    return () => {
      const index = this.activityListeners.indexOf(listener);
      if (index < 0) return; // Removed twice?
      this.activityListeners.splice(index, 1);
    };
  }

  /**
   * Set the entire byte of output values
   * @param byte Raw value to write to outputs
   */
  async setOutput(byte: number) {
    if (byte < 0 || byte > 255)
      throw new RangeError('Output value must be in range [0,255]');

    const ret = this.writeDeviceFile('output', byte);

    ret.then(() => (this.outputs = byte));

    return ret;
  }

  /**
   * Modify outputs of select bits based on cached state.
   * Bits in `mask` set to `1` will be cleared on device
   * @param mask Outputs to sink to ground (Inverted)
   */
  async sinkOutputs(mask: number) {
    this.setOutput(this.outputs & ~mask);
  }

  /**
   * Modify outputs of select bits based on cached state
   * @param mask Bits to set in output byte
   */
  async floatOutputs(mask: number) {
    this.setOutput(this.outputs | mask);
  }
}
