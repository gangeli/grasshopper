import * as THREE from 'three';

/**
 * "Magic window" AR for phones without WebXR AR (iPhone Safari, Android
 * without ARCore): the rear camera's live video fills the screen behind a
 * transparent WebGL canvas, and the phone's orientation sensors turn the
 * virtual camera. Orientation only (3 degrees of freedom): turning and
 * tilting the phone line up with the video; walking around does not move
 * the virtual camera.
 */
type OrientationPermission = { requestPermission?: () => Promise<'granted' | 'denied'> };

export class CameraFeed {
  readonly video: HTMLVideoElement;
  /** World orientation of the camera (three.js convention: looks down -Z). */
  readonly quaternion = new THREE.Quaternion();
  /** Vertical field of view of what is visible on screen (degrees). */
  fovY = 65;
  /** True once the orientation sensor has reported. */
  hasOrientation = false;
  private stream: MediaStream | null = null;
  private target = new THREE.Quaternion();
  private headingOffset: number | null = null;
  private readonly euler = new THREE.Euler();
  private readonly zee = new THREE.Vector3(0, 0, 1);
  private readonly q0 = new THREE.Quaternion();
  // -90° about X: the phone's back camera looks along the device's -Z, not its "top".
  private readonly q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
  private readonly onOrient = (e: DeviceOrientationEvent) => this.orient(e);

  constructor(parent: HTMLElement) {
    this.video = document.createElement('video');
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    this.video.autoplay = true;
    Object.assign(this.video.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', objectFit: 'cover', zIndex: '0', background: '#000' });
    parent.prepend(this.video);
  }

  /**
   * Ask for motion-sensor access. On iOS this must run inside the tap that
   * started the mode (before any other await), or the prompt never appears.
   */
  static requestOrientationPermission(): Promise<boolean> {
    const D = (window as unknown as { DeviceOrientationEvent?: OrientationPermission }).DeviceOrientationEvent;
    if (D && typeof D.requestPermission === 'function') return D.requestPermission().then((r) => r === 'granted', () => false);
    return Promise.resolve(true);
  }

  static available(): boolean {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => undefined);
    window.addEventListener('deviceorientation', this.onOrient);
    window.addEventListener('resize', () => this.updateFov());
    this.video.addEventListener('loadedmetadata', () => this.updateFov());
    this.updateFov();
  }

  stop() {
    window.removeEventListener('deviceorientation', this.onOrient);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video.remove();
  }

  /**
   * What the screen shows of the camera image (object-fit: cover crops it):
   * a phone's main camera sees ~68° across its long side.
   */
  private updateFov() {
    const LONG = (68 * Math.PI) / 180;
    const vw = this.video.videoWidth || 1280, vh = this.video.videoHeight || 720;
    const portraitScreen = window.innerHeight >= window.innerWidth;
    // The stream may report landscape dimensions while displayed upright.
    const [iw, ih] = portraitScreen ? [Math.min(vw, vh), Math.max(vw, vh)] : [Math.max(vw, vh), Math.min(vw, vh)];
    const halfLong = Math.tan(LONG / 2);
    // Image half-extents (tangent space): the long side gets the full field.
    const tx = iw >= ih ? halfLong : (halfLong * iw) / ih;
    const ty = ih >= iw ? halfLong : (halfLong * ih) / iw;
    // Cover: scale the image to fill the screen, cropping the overflowing axis.
    const sa = window.innerWidth / window.innerHeight, ia = iw / ih;
    const visTy = sa > ia ? tx / sa : ty;
    this.fovY = (2 * Math.atan(visTy) * 180) / Math.PI;
  }

  private orient(e: DeviceOrientationEvent) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    const d = Math.PI / 180;
    const screenAngle = ((screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) as number) * d;
    // Standard device-orientation → camera quaternion.
    this.euler.set(e.beta * d, e.alpha * d, -e.gamma * d, 'YXZ');
    const q = this.target.setFromEuler(this.euler);
    q.multiply(this.q1);
    q.multiply(this.q0.setFromAxisAngle(this.zee, -screenAngle));
    // Start facing the game's "forward" (-Z), whatever the compass says.
    const heading = new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
    if (this.headingOffset === null) this.headingOffset = heading;
    q.premultiply(this.q0.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -this.headingOffset));
    if (!this.hasOrientation) this.quaternion.copy(q);
    this.hasOrientation = true;
  }

  /** Ease towards the latest sensor reading (sensor events are noisy and irregular). */
  update(dt: number) {
    if (!this.hasOrientation) return;
    this.quaternion.slerp(this.target, Math.min(1, dt * 25));
  }
}
