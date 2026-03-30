import {
  BATTERY_CHARACTERISTIC_UUID,
  DRIVE_CHARACTERISTIC_UUID,
  GATT_SERVICE_UUID,
  createInitialPlaintext,
  decryptAes128Ecb16,
  encryptAes128Ecb16,
  parseBatteryPercentFromPlaintext,
  setBackward,
  setForward,
  setLeft,
  setRight,
  setStraight,
  setTurbo,
  toggleLights,
} from "./protocol";

const TX_INTERVAL_MS = 10;

type DriveInputs = {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  turbo: boolean;
};

let plaintext = createInitialPlaintext();
let driveChar: BluetoothRemoteGATTCharacteristic | null = null;
let batteryChar: BluetoothRemoteGATTCharacteristic | null = null;
let gatt: BluetoothRemoteGATTServer | null = null;
let txTimer: number | null = null;
let lastBattery: string = "—";

function applyInputsToPlaintext(i: DriveInputs): void {
  if (i.forward) {
    setForward(plaintext, true);
  } else if (i.backward) {
    setBackward(plaintext, true);
  } else {
    setForward(plaintext, false);
    setBackward(plaintext, false);
  }

  if (i.left) setLeft(plaintext, true);
  else if (i.right) setRight(plaintext, true);
  else setStraight(plaintext);

  setTurbo(plaintext, i.turbo);
}

async function sendDriveFrame(): Promise<void> {
  if (!driveChar) return;
  const enc = encryptAes128Ecb16(plaintext);
  try {
    await driveChar.writeValueWithoutResponse(enc);
  } catch {
    // ignore transient queue errors; next tick retries
  }
}

function startTxLoop(): void {
  if (txTimer != null) return;
  txTimer = window.setInterval(() => {
    void sendDriveFrame();
  }, TX_INTERVAL_MS);
}

function stopTxLoop(): void {
  if (txTimer != null) {
    clearInterval(txTimer);
    txTimer = null;
  }
}

async function enableBatteryIfPossible(): Promise<void> {
  if (!batteryChar) return;
  try {
    await batteryChar.startNotifications();
    batteryChar.addEventListener("characteristicvaluechanged", (ev) => {
      const t = ev.target as BluetoothRemoteGATTCharacteristic;
      const v = t.value;
      if (!v || v.byteLength < 16) return;
      const buf = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const slice = buf.length === 16 ? buf : buf.slice(0, 16);
      try {
        const plain = decryptAes128Ecb16(slice);
        const pct = parseBatteryPercentFromPlaintext(plain);
        lastBattery = pct != null ? `${pct}%` : "—";
      } catch {
        lastBattery = "—";
      }
      document.dispatchEvent(new CustomEvent("shellcar:battery", { detail: lastBattery }));
    });
  } catch {
    lastBattery = "n/a";
  }
}

export async function connect(): Promise<void> {
  if (!navigator.bluetooth) {
    throw new Error("Web Bluetooth is not available. Use Chromium on HTTPS or localhost.");
  }

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [GATT_SERVICE_UUID] }],
    optionalServices: [GATT_SERVICE_UUID],
  });

  gatt = await device.gatt!.connect();
  const svc = await gatt.getPrimaryService(GATT_SERVICE_UUID);
  driveChar = await svc.getCharacteristic(DRIVE_CHARACTERISTIC_UUID);
  try {
    batteryChar = await svc.getCharacteristic(BATTERY_CHARACTERISTIC_UUID);
  } catch {
    batteryChar = null;
  }

  await enableBatteryIfPossible();
  startTxLoop();
  device.addEventListener("gattserverdisconnected", () => {
    stopTxLoop();
    driveChar = null;
    batteryChar = null;
    gatt = null;
    document.dispatchEvent(new CustomEvent("shellcar:disconnected"));
  });

  document.dispatchEvent(new CustomEvent("shellcar:connected", { detail: device.name ?? device.id }));
}

export async function disconnect(): Promise<void> {
  stopTxLoop();
  try {
    await gatt?.disconnect();
  } catch {
    /* noop */
  }
  driveChar = null;
  batteryChar = null;
  gatt = null;
  document.dispatchEvent(new CustomEvent("shellcar:disconnected"));
}

export function getBatteryLabel(): string {
  return lastBattery;
}

/** Standard gamepad mapping: D-pad as buttons 12–15 (up, down, left, right). */
const GP_DPAD_UP = 12;
const GP_DPAD_DOWN = 13;
const GP_DPAD_LEFT = 14;
const GP_DPAD_RIGHT = 15;
/** Turbo: L1/R1 + RT (shell-car-remote uses strong trigger press for turbo). */
const GP_L1 = 4;
const GP_R1 = 5;
const GP_RT = 7;
const RT_TURBO = 0.4;
/** Lights: Y/triangle (3), PS / touchpad–style (16–17) — rising edge, like the DS4 “PS” binding. */
const GP_LIGHTS = [3, 16, 17] as const;

function btnPressed(gp: Gamepad, index: number): boolean {
  const b = gp.buttons[index];
  if (!b) return false;
  if (typeof b.value === "number") return b.value > RT_TURBO;
  return !!b.pressed;
}

function btnDown(gp: Gamepad, index: number): boolean {
  return !!gp.buttons[index]?.pressed;
}

/**
 * Left stick + D-pad drive; turbo from shoulders / RT.
 * Returns only axes that are actively driven so keyboard/touch can fill the rest.
 */
function readGamepadAxes(): Partial<DriveInputs> {
  const gp = navigator.getGamepads()[0];
  if (!gp) return {};

  const dead = 0.35;
  const ax = gp.axes[0] ?? 0;
  const ay = gp.axes[1] ?? 0;
  let forward = false;
  let backward = false;
  let left = false;
  let right = false;

  if (ax < -dead) left = true;
  else if (ax > dead) right = true;
  if (ay < -dead) forward = true;
  else if (ay > dead) backward = true;

  if (btnDown(gp, GP_DPAD_UP)) forward = true;
  if (btnDown(gp, GP_DPAD_DOWN)) backward = true;
  if (btnDown(gp, GP_DPAD_LEFT)) left = true;
  if (btnDown(gp, GP_DPAD_RIGHT)) right = true;

  const out: Partial<DriveInputs> = {};
  if (forward) out.forward = true;
  if (backward) out.backward = true;
  if (left) out.left = true;
  if (right) out.right = true;

  const turbo =
    btnDown(gp, GP_L1) ||
    btnDown(gp, GP_R1) ||
    btnPressed(gp, GP_RT);
  if (turbo) out.turbo = true;

  return out;
}

/** Any of the “lights” buttons held this frame (for edge detection). */
function readGamepadLightsHeld(): boolean {
  const gp = navigator.getGamepads()[0];
  if (!gp) return false;
  for (const i of GP_LIGHTS) {
    if (btnDown(gp, i)) return true;
  }
  return false;
}

function mergeInputs(
  base: DriveInputs,
  overlay: Partial<DriveInputs>,
): DriveInputs {
  return {
    forward: overlay.forward !== undefined ? overlay.forward : base.forward,
    backward: overlay.backward !== undefined ? overlay.backward : base.backward,
    left: overlay.left !== undefined ? overlay.left : base.left,
    right: overlay.right !== undefined ? overlay.right : base.right,
    turbo: overlay.turbo !== undefined ? overlay.turbo : base.turbo,
  };
}

/** Degrees — same idea as gamepad dead zone (see readGamepadAxes). */
const ORIENT_DEAD_DEG = 18;

let orientationSteeringEnabled = false;
let orientationSteerBaseline: number | null = null;
let lastSteerTiltDeg: number | null = null;

function getScreenOrientationAngle(): number {
  const a = window.screen?.orientation?.angle;
  if (typeof a === "number" && !Number.isNaN(a)) return a;
  const legacy = (window as Window & { orientation?: number }).orientation;
  if (typeof legacy === "number" && !Number.isNaN(legacy)) return legacy;
  return 0;
}

/**
 * Tilt in the screen’s horizontal plane (left/right steering), not raw gamma.
 * In portrait, gamma is mostly roll; in landscape, that motion often appears on beta — see
 * [deviceorientation](https://developer.mozilla.org/en-US/docs/Web/API/Window/deviceorientation_event).
 */
function steerTiltFromDeviceOrientation(ev: DeviceOrientationEvent): number | null {
  const beta = ev.beta;
  const gamma = ev.gamma;
  if (beta == null || gamma == null) return null;
  const rad = (getScreenOrientationAngle() * Math.PI) / 180;
  return gamma * Math.cos(rad) + beta * Math.sin(rad);
}

function onDeviceOrientation(ev: DeviceOrientationEvent): void {
  if (!orientationSteeringEnabled) return;
  const steer = steerTiltFromDeviceOrientation(ev);
  if (steer == null) return;
  lastSteerTiltDeg = steer;
  if (orientationSteerBaseline == null) {
    orientationSteerBaseline = steer;
  }
}

function resetOrientationSteerBaseline(): void {
  orientationSteerBaseline = null;
}

async function requestDeviceOrientationPermission(): Promise<boolean> {
  const ctor = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<"granted" | "denied">;
  };
  if (typeof ctor.requestPermission === "function") {
    const r = await ctor.requestPermission();
    return r === "granted";
  }
  return true;
}

/**
 * Maps combined screen-horizontal tilt to steer bits, relative to baseline after enable
 * (or after a screen rotation).
 */
function readOrientationSteer(): Partial<DriveInputs> {
  if (!orientationSteeringEnabled || orientationSteerBaseline == null) return {};
  if (lastSteerTiltDeg == null) return {};

  const d = lastSteerTiltDeg - orientationSteerBaseline;
  const out: Partial<DriveInputs> = {};
  if (d < -ORIENT_DEAD_DEG) out.left = true;
  else if (d > ORIENT_DEAD_DEG) out.right = true;
  return out;
}

function setupUi(): void {
  const elStatus = document.getElementById("status");
  const elBattery = document.getElementById("battery");
  const btnConnect = document.getElementById("btn-connect");
  const btnDisconnect = document.getElementById("btn-disconnect");
  const btnLights = document.getElementById("btn-lights");
  const btnTiltSteer = document.getElementById("btn-tilt-steer");

  const keys: DriveInputs = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    turbo: false,
  };

  document.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest("button")) e.preventDefault();
  });
  document.addEventListener("dragstart", (e) => {
    if ((e.target as HTMLElement).closest("button")) e.preventDefault();
  });

  function paintStatus(msg: string): void {
    if (elStatus) elStatus.textContent = msg;
  }

  function paintBattery(): void {
    if (elBattery) elBattery.textContent = lastBattery;
  }

  document.addEventListener("shellcar:connected", ((e: CustomEvent<string>) => {
    paintStatus(`Connected: ${e.detail}`);
    paintBattery();
  }) as EventListener);

  document.addEventListener("shellcar:disconnected", () => {
    paintStatus("Disconnected");
    if (elBattery) elBattery.textContent = "—";
  });

  document.addEventListener("shellcar:battery", ((e: CustomEvent<string>) => {
    if (elBattery) elBattery.textContent = e.detail;
  }) as EventListener);

  btnConnect?.addEventListener("click", () => {
    connect().catch((err: Error) => paintStatus(err.message || String(err)));
  });
  btnDisconnect?.addEventListener("click", () => {
    void disconnect();
  });

  btnLights?.addEventListener("click", () => {
    toggleLights(plaintext);
  });

  function setTiltSteerUi(active: boolean): void {
    if (btnTiltSteer) {
      btnTiltSteer.textContent = active ? "Tilt steer (on)" : "Tilt steer";
      btnTiltSteer.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  btnTiltSteer?.addEventListener("click", () => {
    if (orientationSteeringEnabled) {
      orientationSteeringEnabled = false;
      orientationSteerBaseline = null;
      lastSteerTiltDeg = null;
      window.removeEventListener("deviceorientation", onDeviceOrientation);
      window.removeEventListener("orientationchange", resetOrientationSteerBaseline);
      setTiltSteerUi(false);
      return;
    }

    void (async () => {
      try {
        const ok = await requestDeviceOrientationPermission();
        if (!ok) {
          paintStatus("Tilt steer: permission denied");
          return;
        }
        orientationSteeringEnabled = true;
        orientationSteerBaseline = null;
        lastSteerTiltDeg = null;
        window.addEventListener("deviceorientation", onDeviceOrientation, true);
        window.addEventListener("orientationchange", resetOrientationSteerBaseline);
        setTiltSteerUi(true);
        paintStatus("Tilt steer on — hold level, then tilt left/right");
      } catch (err) {
        paintStatus(
          err instanceof Error ? err.message : "Tilt steer: permission failed",
        );
      }
    })();
  });

  const hold = (id: keyof DriveInputs, down: boolean) => {
    keys[id] = down;
  };

  const map: [string, keyof DriveInputs][] = [
    ["btn-fwd", "forward"],
    ["btn-back", "backward"],
    ["btn-left", "left"],
    ["btn-right", "right"],
    ["btn-turbo", "turbo"],
  ];

  for (const [bid, field] of map) {
    const b = document.getElementById(bid);
    if (!b) continue;
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      hold(field, true);
    });
    b.addEventListener("pointerup", () => hold(field, false));
    b.addEventListener("pointerleave", () => hold(field, false));
    b.addEventListener("pointercancel", () => hold(field, false));
  }

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    switch (e.code) {
      case "ArrowUp":
      case "KeyW":
        hold("forward", true);
        break;
      case "ArrowDown":
      case "KeyS":
        hold("backward", true);
        break;
      case "ArrowLeft":
      case "KeyA":
        hold("left", true);
        break;
      case "ArrowRight":
      case "KeyD":
        hold("right", true);
        break;
      case "ShiftLeft":
      case "ShiftRight":
        hold("turbo", true);
        break;
      case "KeyL":
        toggleLights(plaintext);
        break;
      default:
        break;
    }
  });

  window.addEventListener("keyup", (e) => {
    switch (e.code) {
      case "ArrowUp":
      case "KeyW":
        hold("forward", false);
        break;
      case "ArrowDown":
      case "KeyS":
        hold("backward", false);
        break;
      case "ArrowLeft":
      case "KeyA":
        hold("left", false);
        break;
      case "ArrowRight":
      case "KeyD":
        hold("right", false);
        break;
      case "ShiftLeft":
      case "ShiftRight":
        hold("turbo", false);
        break;
      default:
        break;
    }
  });

  let prevGamepadLights = false;

  function tick(): void {
    const gp = readGamepadAxes();
    const merged = mergeInputs(mergeInputs(keys, gp), readOrientationSteer());
    applyInputsToPlaintext(merged);

    const lightsHeld = readGamepadLightsHeld();
    if (lightsHeld && !prevGamepadLights) {
      toggleLights(plaintext);
    }
    prevGamepadLights = lightsHeld;

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  paintStatus("Idle — connect to QCAR / Shell car");
}

setupUi();
