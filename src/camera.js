// Kamera, Bewegungserkennung und Zuschnitt auf den Kartenrahmen.

const THUMB = 32;

export class Camera {
  constructor(video, frameEl, canvas) {
    this.video = video;
    this.frameEl = frameEl;
    this.canvas = canvas;
    this.track = null;
    this.thumbCanvas = document.createElement('canvas');
    this.thumbCanvas.width = this.thumbCanvas.height = THUMB;
    this.thumbCtx = this.thumbCanvas.getContext('2d', { willReadFrequently: true });
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    this.video.srcObject = stream;
    this.track = stream.getVideoTracks()[0];
    await this.video.play();
    // Autofokus kontinuierlich, wenn unterstützt
    try { await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* egal */ }
  }

  get torchSupported() {
    return !!this.track?.getCapabilities?.().torch;
  }

  async setTorch(on) {
    await this.track.applyConstraints({ advanced: [{ torch: on }] });
  }

  /** Rechteck des Kartenrahmens in Video-Pixeln (object-fit: cover berücksichtigt). */
  cropRect(margin = 0.12) {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    const box = v.getBoundingClientRect();
    const f = this.frameEl.getBoundingClientRect();
    const scale = Math.max(box.width / vw, box.height / vh);
    const offX = (box.width - vw * scale) / 2;
    const offY = (box.height - vh * scale) / 2;
    let x = (f.left - box.left - offX) / scale;
    let y = (f.top - box.top - offY) / scale;
    let w = f.width / scale, h = f.height / scale;
    x -= w * margin; y -= h * margin; w *= 1 + 2 * margin; h *= 1 + 2 * margin;
    x = Math.max(0, x); y = Math.max(0, y);
    w = Math.min(vw - x, w); h = Math.min(vh - y, h);
    return { x, y, w, h };
  }

  /** 32×32-Graustufen-Fingerabdruck des Rahmeninhalts. */
  fingerprint() {
    if (!this.video.videoWidth) return null;
    const r = this.cropRect(0);
    this.thumbCtx.drawImage(this.video, r.x, r.y, r.w, r.h, 0, 0, THUMB, THUMB);
    const d = this.thumbCtx.getImageData(0, 0, THUMB, THUMB).data;
    const out = new Uint8Array(THUMB * THUMB);
    let sum = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      out[j] = (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10;
      sum += out[j];
    }
    // Kontrast (Standardabweichung) → leeres/dunkles Bild erkennen
    const mean = sum / out.length;
    let v = 0;
    for (const p of out) v += (p - mean) ** 2;
    out.contrast = Math.sqrt(v / out.length);
    return out;
  }

  static diff(a, b) {
    if (!a || !b) return 255;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  /** JPEG-Ausschnitt als base64 (ohne data:-Prefix). */
  capture(maxSide = 1100, quality = 0.82) {
    const r = this.cropRect();
    const s = Math.min(1, maxSide / Math.max(r.w, r.h));
    this.canvas.width = Math.round(r.w * s);
    this.canvas.height = Math.round(r.h * s);
    const ctx = this.canvas.getContext('2d');
    ctx.drawImage(this.video, r.x, r.y, r.w, r.h, 0, 0, this.canvas.width, this.canvas.height);
    return this.canvas.toDataURL('image/jpeg', quality).split(',')[1];
  }
}
