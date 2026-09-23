// Bottom-Sheet: closed ↔ peek ↔ full, per Wischen oder Tippen auf den Griff.

const PEEK = 0.62; // Anteil der Bildschirmhöhe im Halb-Modus

export class Sheet {
  constructor(el, handle, body, { onClose } = {}) {
    this.el = el;
    this.body = body;
    this.state = 'closed';
    this.onClose = onClose;
    this.bindDrag(handle);
    // Im Vollbild: am oberen Rand weiter nach unten ziehen → wieder Halb-Modus
    this.bindDrag(body, true);
  }

  offsetFor(state) {
    const h = window.innerHeight;
    if (state === 'full') return 0;
    if (state === 'peek') return h * (1 - PEEK);
    return h;
  }

  set(state) {
    this.state = state;
    this.el.classList.toggle('full', state === 'full');
    this.el.setAttribute('aria-hidden', state === 'closed');
    this.el.style.transform = `translateY(${this.offsetFor(state)}px)`;
    this.body.style.overflowY = state === 'full' ? 'auto' : 'hidden';
    if (state === 'closed') this.onClose?.();
  }

  open() { this.body.scrollTop = 0; this.set('peek'); }
  close() { this.set('closed'); }

  bindDrag(target, fromBody = false) {
    let startY = 0, startOffset = 0, lastY = 0, lastT = 0, velocity = 0, dragging = false, pending = false;

    target.addEventListener('touchstart', (e) => {
      if (this.state === 'closed') return;
      if (fromBody && this.state === 'full' && this.body.scrollTop > 0) return;
      if (fromBody && e.target.closest('input, button, a, select')) return;
      startY = lastY = e.touches[0].clientY;
      lastT = performance.now();
      startOffset = this.offsetFor(this.state);
      dragging = !fromBody; // Body: erst entscheiden, wenn Richtung klar ist
      velocity = 0;
      pending = fromBody;
    }, { passive: true });

    target.addEventListener('touchmove', (e) => {
      if (this.state === 'closed') return;
      const y = e.touches[0].clientY;
      const dy = y - startY;
      if (pending) {
        if (Math.abs(dy) < 6) return;
        // Im Halb-Modus steuert jede vertikale Geste das Sheet; im Vollbild nur Ziehen nach unten am Anfang.
        const takeOver = this.state === 'peek' || (dy > 0 && this.body.scrollTop <= 0);
        pending = false;
        if (!takeOver) return;
        dragging = true;
      }
      if (!dragging) return;
      e.preventDefault();
      const now = performance.now();
      velocity = (y - lastY) / Math.max(1, now - lastT);
      lastY = y; lastT = now;
      this.el.classList.add('dragging');
      this.el.style.transform = `translateY(${Math.max(0, startOffset + dy)}px)`;
    }, { passive: false });

    const end = () => {
      pending = false;
      if (!dragging) return;
      dragging = false;
      this.el.classList.remove('dragging');
      const cur = startOffset + (lastY - startY);
      const h = window.innerHeight;
      let next;
      if (velocity > 0.6) next = this.state === 'full' && cur < h * (1 - PEEK) ? 'peek' : 'closed';
      else if (velocity < -0.6) next = 'full';
      else {
        const points = { full: 0, peek: h * (1 - PEEK), closed: h };
        next = Object.entries(points).sort((a, b) => Math.abs(a[1] - cur) - Math.abs(b[1] - cur))[0][0];
      }
      this.set(next);
    };
    target.addEventListener('touchend', end);
    target.addEventListener('touchcancel', end);

    if (!fromBody) {
      target.addEventListener('click', () => {
        if (this.state === 'peek') this.set('full');
        else if (this.state === 'full') this.set('peek');
      });
    }
  }
}
