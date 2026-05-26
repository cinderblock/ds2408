import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DS2408, findAttachedDevices } from './ds2408.js';

/** Set up a fake `/sys/bus/w1/devices` with the given serials and initial register bytes. */
async function makeFakeBus(
  devices: Record<string, Partial<Record<string, number>>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ds2408-test-'));
  for (const [serial, registers] of Object.entries(devices)) {
    const deviceDir = join(root, serial);
    await mkdir(deviceDir, { recursive: true });
    const allRegs = {
      activity: 0,
      cond_search_mask: 0,
      cond_search_polarity: 0,
      output: 0xff,
      state: 0xff,
      status_control: 0,
      ...registers,
    } as Record<string, number>;
    for (const [name, value] of Object.entries(allRegs)) {
      await writeFile(join(deviceDir, name), Buffer.from([value & 0xff]));
    }
  }
  return root;
}

async function writeRegister(
  bus: string,
  serial: string,
  name: string,
  value: number,
): Promise<void> {
  await writeFile(join(bus, serial, name), Buffer.from([value & 0xff]));
}

async function readRegister(
  bus: string,
  serial: string,
  name: string,
): Promise<number> {
  const buf = await readFile(join(bus, serial, name));
  return buf.readUInt8(0);
}

test('findAttachedDevices returns only DS2408 (29-*) serials', async () => {
  const bus = await makeFakeBus({
    '29-aaa': {},
    '29-bbb': {},
    '28-temp': {}, // DS18B20 temperature, not a DS2408
    'w1_bus_master1': {},
  });
  try {
    const found = await findAttachedDevices(bus);
    assert.deepEqual(found.sort(), ['29-aaa', '29-bbb']);
  } finally {
    await rm(bus, { recursive: true, force: true });
  }
});

test('DS2408.open auto-selects the first 29-* device', async () => {
  const bus = await makeFakeBus({
    '29-aaa': { output: 0xa5 },
    '29-bbb': { output: 0x5a },
  });
  try {
    const ds = await DS2408.open(undefined, {
      devicesDir: bus,
      verificationLoops: 0,
    });
    assert.match(ds.serial, /^29-/);
    // We don't actually require which one is first — depends on readdir order.
    assert.ok(ds.serial === '29-aaa' || ds.serial === '29-bbb');
  } finally {
    await rm(bus, { recursive: true, force: true });
  }
});

test('DS2408.open with no devices throws', async () => {
  const bus = await makeFakeBus({});
  try {
    await assert.rejects(
      () => DS2408.open(undefined, { devicesDir: bus, verificationLoops: 0 }),
      /No DS2408 devices found/,
    );
  } finally {
    await rm(bus, { recursive: true, force: true });
  }
});

test('DS2408.open with wrong-prefix serial throws', async () => {
  const bus = await makeFakeBus({ '28-something': {} });
  try {
    await assert.rejects(
      () =>
        DS2408.open('28-something', {
          devicesDir: bus,
          verificationLoops: 0,
        }),
      /DS2408 serials start with "29-"/,
    );
  } finally {
    await rm(bus, { recursive: true, force: true });
  }
});

test('readState / readControl / readOutput round-trip', async () => {
  const bus = await makeFakeBus({
    '29-x': { state: 0x12, status_control: 0x34, output: 0x56 },
  });
  try {
    const ds = await DS2408.open('29-x', {
      devicesDir: bus,
      verificationLoops: 0,
    });
    assert.equal(await ds.readState(), 0x12);
    assert.equal(await ds.readControl(), 0x34);
    assert.equal(await ds.readOutput(), 0x56);
  } finally {
    await rm(bus, { recursive: true, force: true });
  }
});

test('setOutput rejects out-of-range and non-integer values', async () => {
  const bus = await makeFakeBus({ '29-x': {} });
  try {
    const ds = await DS2408.open('29-x', {
      devicesDir: bus,
      verificationLoops: 0,
    });
    await assert.rejects(() => ds.setOutput(-1), RangeError);
    await assert.rejects(() => ds.setOutput(256), RangeError);
    await assert.rejects(() => ds.setOutput(1.5), RangeError);
  } finally {
    await rm(bus, { recursive: true, force: true });
  }
});

test('setOutput writes the byte and updates the cache', async () => {
  const bus = await makeFakeBus({ '29-x': { output: 0xff } });
  try {
    const ds = await DS2408.open('29-x', {
      devicesDir: bus,
      verificationLoops: 0,
    });
    await ds.setOutput(0x42);
    assert.equal(await readRegister(bus, '29-x', 'output'), 0x42);
    // Cached value used by sinkOutputs/floatOutputs.
    await ds.sinkOutputs(0b1);
    assert.equal(await readRegister(bus, '29-x', 'output'), 0x42 & ~0b1);
  } finally {
    await rm(bus, { recursive: true, force: true });
  }
});

test('sinkOutputs / floatOutputs / maskedSetOutputs work against the cache', async () => {
  const bus = await makeFakeBus({ '29-x': { output: 0x00 } });
  try {
    const ds = await DS2408.open('29-x', {
      devicesDir: bus,
      verificationLoops: 0,
    });
    await ds.setOutput(0b1010_1010);
    await ds.floatOutputs(0b0000_0101);
    assert.equal(await readRegister(bus, '29-x', 'output'), 0b1010_1111);
    await ds.sinkOutputs(0b1111_0000);
    assert.equal(await readRegister(bus, '29-x', 'output'), 0b0000_1111);
    await ds.maskedSetOutputs(0b0000_1111, 0b1111_0011);
    assert.equal(await readRegister(bus, '29-x', 'output'), 0b0000_0011);
  } finally {
    await rm(bus, { recursive: true, force: true });
  }
});

test('setControls only modifies the requested bits when read=true', async () => {
  const bus = await makeFakeBus({ '29-x': { status_control: 0b0000_0010 } });
  try {
    const ds = await DS2408.open('29-x', {
      devicesDir: bus,
      verificationLoops: 0,
    });
    // ROS bit (idx 2) on; CT (idx 1) was 1 and should stay.
    await ds.setControls({ ROS: true });
    const v = await readRegister(bus, '29-x', 'status_control');
    assert.equal(v & 0b0000_0010, 0b0000_0010); // CT preserved
    assert.equal(v & 0b0000_0100, 0b0000_0100); // ROS set
  } finally {
    await rm(bus, { recursive: true, force: true });
  }
});

test('setControls with read=false zeroes unspecified bits', async () => {
  const bus = await makeFakeBus({ '29-x': { status_control: 0xff } });
  try {
    const ds = await DS2408.open('29-x', {
      devicesDir: bus,
      verificationLoops: 0,
    });
    await ds.setControls({ PLS: true }, false);
    assert.equal(await readRegister(bus, '29-x', 'status_control'), 0b0000_0001);
  } finally {
    await rm(bus, { recursive: true, force: true });
  }
});

test('readDeviceFile stabilises across verificationLoops identical reads', async () => {
  const bus = await makeFakeBus({ '29-x': { state: 0x55 } });
  try {
    // verificationLoops=2 → needs 3 consecutive identical reads
    const ds = await DS2408.open('29-x', {
      devicesDir: bus,
      verificationLoops: 2,
    });
    assert.equal(await ds.readState(), 0x55);
  } finally {
    await rm(bus, { recursive: true, force: true });
  }
});

test('pollActivity returns zero when nothing has happened, non-zero clears the byte', async () => {
  const bus = await makeFakeBus({
    '29-x': { activity: 0, state: 0x33 },
  });
  try {
    const ds = await DS2408.open('29-x', {
      devicesDir: bus,
      verificationLoops: 0,
    });
    let res = await ds.pollActivity();
    assert.equal(res.activity, 0);
    assert.equal(res.state, 0x33);

    await writeRegister(bus, '29-x', 'activity', 0b0000_1010);
    res = await ds.pollActivity();
    assert.equal(res.activity, 0b0000_1010);
    // pollActivity write-clears the file in the kernel; in our fake bus
    // a write puts whatever we wrote, so writing 0 zeroes it.
    assert.equal(await readRegister(bus, '29-x', 'activity'), 0);
  } finally {
    await rm(bus, { recursive: true, force: true });
  }
});

test('startActivityLoop fires listeners on non-zero activity, then stopActivityLoop cleans up', async () => {
  const bus = await makeFakeBus({
    '29-x': { activity: 0, state: 0xc3 },
  });
  try {
    const ds = await DS2408.open('29-x', {
      devicesDir: bus,
      verificationLoops: 0,
    });

    const observations: Array<{ activity: number; state: number }> = [];
    ds.onActivity((activity, state) => {
      observations.push({ activity, state });
    });

    ds.startActivityLoop({ loopDelay: 10 });
    // Let one tick happen with activity=0.
    await new Promise(r => setTimeout(r, 30));
    assert.equal(observations.length, 0);

    // Inject activity and wait for the next tick.
    await writeRegister(bus, '29-x', 'activity', 0xa5);
    await new Promise(r => setTimeout(r, 40));

    await ds.stopActivityLoop();
    assert.ok(!ds.isActivityLoopRunning);
    assert.ok(observations.length >= 1);
    assert.equal(observations[0]!.activity, 0xa5);
  } finally {
    await rm(bus, { recursive: true, force: true });
  }
});

test('startActivityLoop / stopActivityLoop are idempotent', async () => {
  const bus = await makeFakeBus({ '29-x': {} });
  try {
    const ds = await DS2408.open('29-x', {
      devicesDir: bus,
      verificationLoops: 0,
    });
    ds.startActivityLoop({ loopDelay: 1000 });
    ds.startActivityLoop({ loopDelay: 1000 }); // no-op
    assert.ok(ds.isActivityLoopRunning);
    await ds.stopActivityLoop();
    await ds.stopActivityLoop(); // no-op
    assert.ok(!ds.isActivityLoopRunning);
  } finally {
    await rm(bus, { recursive: true, force: true });
  }
});
