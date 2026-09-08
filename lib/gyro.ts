/**
 * Device orientation, armed from the first paint.
 *
 * iOS hands out orientation only after an explicit grant, and only from a user
 * gesture — so the listener that asks has to already be in place when the first
 * tap lands. This used to sit inside <Stickers>, which Scene only renders once
 * the model is live: by then the loader had already swallowed the reader's
 * first tap, so being asked at all took a second one, and anyone who tapped
 * once and then just watched the scene was never asked and never got the tilt.
 * That is the whole of "sometimes it prompts and sometimes it doesn't" — the
 * rest is iOS remembering the answer for the origin, which it is entitled to.
 *
 * Module scope rather than a hook, because a grant belongs to the document and
 * not to whichever component happens to want a reading. Nothing here tears
 * down: it is armed once and lives as long as the page.
 */

type Reader = (e: DeviceOrientationEvent) => void;

const readers = new Set<Reader>();
let armed = false;
let flowing = false;

const relay = (e: DeviceOrientationEvent) => {
  for (const read of readers) read(e);
};

/*
 * Two names for the same reading. Chrome on Android fires the plain one; some
 * builds only ever fire the absolute one, and a browser that sends both just
 * overwrites the same four properties twice.
 */
const flow = () => {
  if (flowing) return;
  flowing = true;
  window.addEventListener('deviceorientation', relay);
  window.addEventListener('deviceorientationabsolute', relay as EventListener);
};

/**
 * Take readings. Returns the unsubscribe.
 *
 * Subscribing after the grant is fine and is the normal case — the sticker
 * layer mounts long after the tap that asked.
 */
export function onGyro(read: Reader) {
  readers.add(read);
  return () => {
    readers.delete(read);
  };
}

/**
 * Ask for orientation on the first gesture, once per document. Safe to call
 * again; later calls are ignored.
 */
export function armGyro() {
  if (armed) return;
  if (typeof window === 'undefined') return;
  if (typeof DeviceOrientationEvent === 'undefined') return;
  armed = true;

  /*
   * Orientation is gated on a secure context in every current browser: Chrome
   * drops the event without a word on an insecure origin, and iOS rejects the
   * permission call. `http://localhost` counts as secure and the LAN address
   * the dev server also prints does not — which is the address a phone has to
   * use, so the tilt is dead on a phone for a reason that has nothing to do
   * with the phone. Worth a line in the console, since neither browser gives
   * one.
   */
  if (!window.isSecureContext) {
    console.warn(
      '[gyro] no tilt: device orientation needs https (or localhost). ' +
        `this page is ${window.location.origin}.`,
    );
  }

  /*
   * Feature-detected off the constructor, but *called* on it. Safari's
   * requestPermission is a static method that checks its receiver, and a bare
   * reference invoked as `permission()` arrives with `this` undefined — which
   * throws a TypeError that the catch below then swallows, so iOS asks for
   * nothing, grants nothing, and reports nothing.
   */
  const gate = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<PermissionState>;
  };

  if (typeof gate.requestPermission !== 'function') {
    flow();
    return;
  }

  const ask = () => {
    window.removeEventListener('touchend', ask);
    window.removeEventListener('pointerup', ask);
    gate
      .requestPermission!()
      .then((state) => {
        if (state === 'granted') flow();
        else console.warn(`[gyro] no tilt: orientation ${state}.`);
      })
      .catch((err) => {
        // Left visible on purpose. A rejection here is the whole feature
        // failing, and it is the one thing a phone gives no other sign of.
        console.warn('[gyro] no tilt: permission call failed.', err);
      });
  };

  // Either gesture will do; whichever lands first takes the other one down.
  window.addEventListener('touchend', ask, { once: true });
  window.addEventListener('pointerup', ask, { once: true });
}
