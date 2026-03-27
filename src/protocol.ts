/**
 * Brandbase / QCAR-style Shell Motorsport BLE control frames.
 * Plaintext layout and AES key match github.com/luchojuarez/shell-car-remote (car/brandbase.go, service/cipher.go).
 */

import aesjs from "aes-js";

/** 16-byte key as in shell-car-remote BrandFactory.GetCipher() */
export const AES_KEY_HEX = "34522a5b7a6e492c08090a9d8d2a23f8";

/** GATT service (FFF0) used by the car */
export const GATT_SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb";

/** Write: encrypted 16-byte drive command */
export const DRIVE_CHARACTERISTIC_UUID = "d44bc439-abfd-45a2-b575-925416129600";

/** Notify: encrypted battery updates (optional) */
export const BATTERY_CHARACTERISTIC_UUID = "d44bc439-abfd-45a2-b575-925416129601";

const CTL = [0x43, 0x54, 0x4c] as const;

const Zero = 0x00;
const One = 0x01;
const Mask = 0x01;

export const SpeedNormal = 0x50;
export const SpeedFast = 0x64;

/** Byte indices in the 16-byte plaintext CTL frame */
export const I = {
  header0: 0,
  c: 1,
  t: 2,
  l: 3,
  forward: 4,
  backward: 5,
  left: 6,
  right: 7,
  lights: 8,
  speed: 9,
} as const;

/**
 * Initial plaintext matches car.NewBrandMessage() / brandbase_test.go:
 * hexa `0043544c000000000150000000000000`
 */
export function createInitialPlaintext(): Uint8Array {
  return new Uint8Array([
    Zero,
    CTL[0],
    CTL[1],
    CTL[2],
    Zero, // forward
    Zero, // backward
    Zero, // left
    Zero, // right
    One, // lights on by default (same as Go)
    SpeedNormal,
    Zero,
    Zero,
    Zero,
    Zero,
    Zero,
    Zero,
  ]);
}

export function encryptAes128Ecb16(plaintext16: Uint8Array): Uint8Array {
  if (plaintext16.length !== 16) {
    throw new Error("AES-128-ECB expects exactly 16 bytes");
  }
  const key = aesjs.utils.hex.toBytes(AES_KEY_HEX);
  const ecb = new aesjs.ModeOfOperation.ecb(key);
  return new Uint8Array(ecb.encrypt(Array.from(plaintext16)));
}

export function decryptAes128Ecb16(ciphertext16: Uint8Array): Uint8Array {
  if (ciphertext16.length !== 16) {
    throw new Error("AES-128-ECB expects exactly 16 bytes");
  }
  const key = aesjs.utils.hex.toBytes(AES_KEY_HEX);
  const ecb = new aesjs.ModeOfOperation.ecb(key);
  return new Uint8Array(ecb.decrypt(Array.from(ciphertext16)));
}

/** Apply movement bits (0x00 / 0x01) per shell-car-remote BrandStatus */
export function setForward(p: Uint8Array, on: boolean): void {
  p[I.forward] = on ? One : Zero;
  if (on) p[I.backward] = Zero;
}

export function setBackward(p: Uint8Array, on: boolean): void {
  p[I.backward] = on ? One : Zero;
  if (on) p[I.forward] = Zero;
}

export function setLeft(p: Uint8Array, on: boolean): void {
  p[I.left] = on ? One : Zero;
  if (on) p[I.right] = Zero;
}

export function setRight(p: Uint8Array, on: boolean): void {
  p[I.right] = on ? One : Zero;
  if (on) p[I.left] = Zero;
}

export function setStraight(p: Uint8Array): void {
  p[I.left] = Zero;
  p[I.right] = Zero;
}

export function toggleLights(p: Uint8Array): void {
  p[I.lights] = (~p[I.lights] & 0xff) & Mask;
}

export function setTurbo(p: Uint8Array, on: boolean): void {
  p[I.speed] = on ? SpeedFast : SpeedNormal;
}

/** Battery handler matches Go: percentage from hex digit of decrypted byte index 4 */
export function parseBatteryPercentFromPlaintext(decrypted: Uint8Array): number | null {
  if (decrypted.length < 5) return null;
  const hexDigit = decrypted[4].toString(16);
  const n = parseInt(hexDigit, 16);
  return Number.isFinite(n) ? n : null;
}
