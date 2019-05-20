import { promises as fsPromise, readdirSync } from 'fs';

export function onAttach(listener: (serial: string) => void) {
  console.log('Unimplemented');

  return () => {
    console.log('Unimplemented remove onAttach listener');
  };
}

export type ActivityListener = (byte: number) => void;

const emptyBuffer = Buffer.allocUnsafe(0);

export default class DS2408 {
  readonly serial: string;

  private lastActivity?: number;

  private activityListeners: ActivityListener[];

  constructor(serial?: string) {
    if (!serial) {
      serial = readdirSync('/sys/bus/w1/devices').find(s =>
        s.startsWith('29-')
      );
      if (!serial) throw new Error('Did not find any attached DS2408 devices');
      console.log('Automatically detected first DS2408 device serial:', serial);
    } else if (!serial.startsWith('29-')) {
      throw new Error('DS2408 serial numbers start with `29-`');
    }

    this.serial = serial;
    this.lastActivity = undefined;
    this.activityListeners = [];

    const activityLoop = async () => {
      try {
        await this.updateActivity();
      } catch (e) {}
      setImmediate(activityLoop);
    };

    setImmediate(activityLoop);
  }

  deviceFile(filename: string) {
    return '/sys/bus/w1/devices/' + this.serial + '/' + filename;
  }

  clearActivity() {
    return fsPromise.writeFile(this.deviceFile('activity'), emptyBuffer);
  }

  private async readActivity() {
    return (await fsPromise.readFile(this.deviceFile('activity'))).readUInt8(0);
  }

  async updateActivity() {
    const a = await this.readActivity();
    if (a === this.lastActivity) return;
    await this.clearActivity();

    console.log('New Activity:', a);

    this.activityListeners.forEach(l => l(a));

    console.log('Cleared Activity. Now:', await this.readActivity());
  }

  onActivity(listener: ActivityListener) {
    this.activityListeners.push(listener);

    return () => {
      const index = this.activityListeners.indexOf(listener);
      if (index < 0) return; // Removed twice?
      this.activityListeners.splice(index, 1);
    };
  }

  async setOutputs(byte: number | string) {
    byte = Number(byte);
    if (byte < 0 || byte > 255)
      throw new RangeError('Output value must be in range [0,255]');

    const b = Buffer.allocUnsafe(1);
    b[0] = byte;

    return fsPromise.writeFile(this.deviceFile('output'), b);
  }
}
