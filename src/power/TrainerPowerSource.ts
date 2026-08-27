import type { PowerContext, PowerSource } from './PowerSource';

/**
 * Web Bluetooth power-meter source — the reason the spacebar mechanic exists.
 *
 * NOT WIRED INTO THE GAME YET. `Game` constructs a SpacebarPowerSource for
 * human slots; swapping in this class is the whole integration, because every
 * consumer downstream only reads `watts`.
 *
 * The GATT parsing below follows the Bluetooth SIG specs and is written to be
 * correct, but it has not been run against real hardware in this project, so
 * treat the first pairing as a debugging session rather than a smoke test.
 *
 * Cycling Power Service (0x1818) / Cycling Power Measurement (0x2A63):
 *   bytes 0-1  uint16  flags
 *   bytes 2-3  sint16  instantaneous power, watts
 * Instantaneous power sits at a fixed offset because it is a mandatory field
 * that precedes every optional one, so the flags only matter for fields after
 * it. That makes a power-only reader pleasantly short.
 *
 * FTMS (0x1826) / Indoor Bike Data (0x2AD2) is the fallback for smart trainers
 * that do not advertise CPS. There instantaneous power is at a variable offset
 * because the preceding fields are optional, so the flags must be walked.
 *
 * Browser support: Web Bluetooth is Chromium-only and requires a secure
 * context (https, or http://localhost) plus a user gesture to call requestDevice.
 */

const CYCLING_POWER_SERVICE = 0x1818;
const CYCLING_POWER_MEASUREMENT = 0x2a63;
const FITNESS_MACHINE_SERVICE = 0x1826;
const INDOOR_BIKE_DATA = 0x2ad2;

export type TrainerStatus = 'idle' | 'connecting' | 'connected' | 'error';

export class TrainerPowerSource implements PowerSource {
  readonly kind = 'trainer' as const;

  private value = 0;
  private deviceName = 'TRAINER';
  private status: TrainerStatus = 'idle';
  private device: BluetoothDevice | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private lastPacketAt = 0;
  private elapsed = 0;

  get label(): string {
    return this.deviceName.toUpperCase();
  }

  get ready(): boolean {
    return this.status === 'connected';
  }

  get watts(): number {
    return this.value;
  }

  getStatus(): TrainerStatus {
    return this.status;
  }

  /**
   * Must be called from a user gesture (a click on a "Pair trainer" button).
   * Resolves once notifications are flowing.
   */
  async connect(): Promise<void> {
    if (!('bluetooth' in navigator)) {
      this.status = 'error';
      throw new Error('Web Bluetooth is unavailable in this browser.');
    }
    this.status = 'connecting';
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [CYCLING_POWER_SERVICE] }, { services: [FITNESS_MACHINE_SERVICE] }],
        optionalServices: [CYCLING_POWER_SERVICE, FITNESS_MACHINE_SERVICE],
      });
      this.device = device;
      this.deviceName = device.name ?? 'Trainer';
      const server = await device.gatt?.connect();
      if (!server) throw new Error('GATT server unavailable.');

      const { characteristic, parser } = await this.resolveCharacteristic(server);
      this.characteristic = characteristic;
      characteristic.addEventListener('characteristicvaluechanged', (event) => {
        const target = event.target as BluetoothRemoteGATTCharacteristic;
        if (!target.value) return;
        const watts = parser(target.value);
        if (watts !== null) {
          this.value = watts;
          this.lastPacketAt = this.elapsed;
        }
      });
      await characteristic.startNotifications();
      this.status = 'connected';
    } catch (error) {
      this.status = 'error';
      throw error;
    }
  }

  private async resolveCharacteristic(server: BluetoothRemoteGATTServer): Promise<{
    characteristic: BluetoothRemoteGATTCharacteristic;
    parser: (view: DataView) => number | null;
  }> {
    try {
      const service = await server.getPrimaryService(CYCLING_POWER_SERVICE);
      const characteristic = await service.getCharacteristic(CYCLING_POWER_MEASUREMENT);
      return { characteristic, parser: parseCyclingPowerMeasurement };
    } catch {
      const service = await server.getPrimaryService(FITNESS_MACHINE_SERVICE);
      const characteristic = await service.getCharacteristic(INDOOR_BIKE_DATA);
      return { characteristic, parser: parseIndoorBikeData };
    }
  }

  begin(_context: PowerContext): void {
    this.lastPacketAt = this.elapsed;
  }

  update(deltaSeconds: number): void {
    this.elapsed += deltaSeconds;
    // Trainers notify at roughly 1-4 Hz. If the stream stalls for longer than
    // three seconds, decay toward zero rather than freezing the last reading,
    // so a dropout reads as "stopped pedalling" instead of a held wattage.
    if (this.elapsed - this.lastPacketAt > 3) {
      this.value *= Math.exp(-deltaSeconds / 1.5);
    }
  }

  end(): void {
    // Deliberately keeps streaming: a rider does not stop pedalling between turns.
  }

  async dispose(): Promise<void> {
    try {
      await this.characteristic?.stopNotifications();
    } catch {
      // Device may already be gone; nothing useful to do.
    }
    this.characteristic = null;
    this.device?.gatt?.disconnect();
    this.device = null;
    this.status = 'idle';
  }
}

/** Cycling Power Measurement (0x2A63): instantaneous power is sint16 at byte 2. */
export function parseCyclingPowerMeasurement(view: DataView): number | null {
  if (view.byteLength < 4) return null;
  return view.getInt16(2, /* littleEndian */ true);
}

/**
 * Indoor Bike Data (0x2AD2): every field after the flags is optional, so the
 * offset of instantaneous power depends on which flag bits are set. Walk them
 * in spec order and accumulate widths.
 */
export function parseIndoorBikeData(view: DataView): number | null {
  if (view.byteLength < 3) return null;
  const flags = view.getUint16(0, true);
  let offset = 2;

  // Bit 0 INVERTED: 0 means Instantaneous Speed IS present.
  if ((flags & 0x0001) === 0) offset += 2;
  if (flags & 0x0002) offset += 2; // Average Speed
  if (flags & 0x0004) offset += 2; // Instantaneous Cadence
  if (flags & 0x0008) offset += 2; // Average Cadence
  if (flags & 0x0010) offset += 3; // Total Distance (uint24)
  if (flags & 0x0020) offset += 2; // Resistance Level
  if (!(flags & 0x0040)) return null; // Instantaneous Power absent
  if (offset + 2 > view.byteLength) return null;
  return view.getInt16(offset, true);
}
