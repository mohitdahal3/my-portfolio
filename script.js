// ---- Config ----
const SRC_LANDSCAPE = "videos/ratio16_9.mp4";
const SRC_PORTRAIT  = "videos/ratio9_16.mp4";
const CROSSFADE_MS  = 300; // match Tailwind duration-300
const SWAP_DEBOUNCE = 180; // resize debounce

// (Optional) If you want to make source URLs less obvious, set this to true
// and we will fetch blobs and assign blob: URLs instead of file paths.
// Note: still not bulletproof against devtools.
const OBFUSCATE_SOURCES = false;

// ---- Helpers ----
function chooseVariant(w, h) {
  const r = w / h;
  const R_L = 16 / 9;
  const R_P = 9 / 16;
  const dL = Math.abs(Math.log(r / R_L));
  const dP = Math.abs(Math.log(r / R_P));
  return dL <= dP ? "landscape" : "portrait";
}

function setOpacity(el, value) {
  if (!el) return;
  el.style.opacity = value;
}

function playSafely(video) {
  if (!video) return;
  const p = video.play();
  if (p && typeof p.catch === "function") {
    p.catch(() => {
      // Autoplay might be blocked in rare cases; leave it silent.
    });
  }
}

async function assignSrc(video, src) {
  if (!video) return;
  if (OBFUSCATE_SOURCES) {
    // Fetch as blob to hide direct URL (not bulletproof, but less obvious)
    try {
      const res = await fetch(src, { credentials: "same-origin" });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      // Revoke previous blob if any
      if (video.dataset.blobUrl) {
        URL.revokeObjectURL(video.dataset.blobUrl);
      }
      video.src = url;
      video.dataset.blobUrl = url;
    } catch {
      // Fallback to direct src if fetch fails
      video.src = src;
    }
  } else {
    video.src = src;
  }
  video.removeAttribute("loop"); // ensure no loop
  video.controls = false;        // ensure no controls
}

// ---- Main ----
document.addEventListener("DOMContentLoaded", async () => {
  const vidL = document.getElementById("vidLandscape");
  const vidP = document.getElementById("vidPortrait");

  // Initial pick
  let variant = chooseVariant(window.innerWidth, window.innerHeight);
  let current = variant === "landscape" ? vidL : vidP;
  let other   = variant === "landscape" ? vidP : vidL;

  // Assign sources
  await assignSrc(vidL, SRC_LANDSCAPE);
  await assignSrc(vidP, SRC_PORTRAIT);

  // Prefer not to waste data: keep portrait preload=metadata initially.
  // If on fast connection, we can upgrade preloading after idle.
  if ("connection" in navigator && navigator.connection?.effectiveType === "4g" && !navigator.connection?.saveData) {
    requestIdleCallback?.(() => { vidP.preload = "auto"; vidL.preload = "auto"; });
  }

  // When metadata is ready, start playing the chosen one
  const ensureStart = () => {
    // Start the chosen video
    setOpacity(current, "1");
    playSafely(current);
  };

  if (current.readyState >= 1) {
    ensureStart();
  } else {
    current.addEventListener("loadedmetadata", ensureStart, { once: true });
  }

  // End behavior: do nothing (no loop)
  [vidL, vidP].forEach(v => {
    v.loop = false;
    v.controls = false;
    v.addEventListener("contextmenu", e => e.preventDefault()); // minor friction
  });

  // ---- Resize logic: Only swap if closer aspect changes ----
  let resizeTimer = null;
  function onSmartResize() {
    const newVariant = chooseVariant(window.innerWidth, window.innerHeight);
    if (newVariant === variant) return; // nothing to do

    // Swap
    const prev = current;
    current = newVariant === "landscape" ? vidL : vidP;
    other   = current === vidL ? vidP : vidL;
    variant = newVariant;

    // Keep timeline: grab currentTime from the previous video
    const t = prev.currentTime || 0;

    // If new video doesn't have metadata yet, wait before seeking
    const startNew = () => {
      try {
        // Clamp to duration if we know it
        const targetTime = Math.min(
          t,
          Number.isFinite(current.duration) ? Math.max(current.duration - 0.05, 0) : t
        );
        // Seek & show
        current.currentTime = targetTime;
      } catch { /* some browsers throw on early seek; ignore */ }

      setOpacity(prev, "0");
      setOpacity(current, "1");

      // Pause previous after crossfade to save CPU
      setTimeout(() => prev.pause(), CROSSFADE_MS + 30);

      playSafely(current);
    };

    if (current.readyState >= 1) {
      startNew();
    } else {
      current.addEventListener("loadedmetadata", startNew, { once: true });
      // Ensure source exists (assigned earlier) and load if needed
      current.load();
    }
  }

  const debouncedResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(onSmartResize, SWAP_DEBOUNCE);
  };

  window.addEventListener("resize", debouncedResize);
  window.addEventListener("orientationchange", debouncedResize);
});



// === Mouse Trail (tapered, time-decaying, speed-responsive) ===
(() => {
  const canvas = document.getElementById('mouseTrail');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // HiDPI crispness + cover viewport
  let width, height, dpr;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    width  = window.innerWidth;
    height = window.innerHeight;
    canvas.style.width  = width + 'px';
    canvas.style.height = height + 'px';
    canvas.width  = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize, { passive: true });
  resize();

  // Tunables
  const MAX_AGE_MS   = 100;   // lifespan of a point; controls how fast the tail "catches up"
  const MAX_POINTS   = 1000;   // safety cap
  const BASE_WIDTH   = 8;     // peak thickness (px) in the middle of the trail
  const COLOR        = [255, 255, 255]; // white

  const pts = [];

  function addPoint(x, y, t) {
    pts.push({ x, y, t });
    if (pts.length > MAX_POINTS) pts.shift();
  }

  // Use pointer events (works for mouse/touch/pen)
  window.addEventListener('pointermove', (e) => {
    addPoint(e.clientX, e.clientY, performance.now());
  }, { passive: true });

  function draw() {
    const now = performance.now();

    // Purge old points so tail always shrinks when you stop
    while (pts.length && (now - pts[0].t) > MAX_AGE_MS) pts.shift();

    ctx.clearRect(0, 0, width, height);

    if (pts.length > 1) {
      // Compute cumulative arc length for nice taper by length fraction
      const segLen = new Array(pts.length).fill(0);
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        const d  = Math.hypot(dx, dy);
        total += d;
        segLen[i] = total;
      }

      if (total > 0.5) {
        ctx.lineJoin = 'round';
        ctx.lineCap  = 'round';

        // Draw small segments with varying width/alpha to create a tapered ribbon
        for (let i = 1; i < pts.length; i++) {
          const s0 = segLen[i - 1] / total;   // 0..1 along the trail
          const s1 = segLen[i]     / total;   // 0..1
          const s  = (s0 + s1) * 0.5;         // segment center

          // Thickness profile: peak at middle, pointy at both ends
          const profile = Math.sin(Math.PI * s); // 0 at ends, 1 at center
          if (profile <= 0) continue;

          // Time fade so tail erases itself (older → more transparent)
          const age   = (now - pts[i].t) / MAX_AGE_MS;   // 0..1
          const fade  = Math.max(0, 1 - age);

          const w = BASE_WIDTH * profile;
          if (w <= 0.01 || fade <= 0.01) continue;

          ctx.lineWidth   = w;
          ctx.strokeStyle = `rgba(${COLOR[0]},${COLOR[1]},${COLOR[2]},${0.9 * profile * fade})`;
          ctx.beginPath();
          ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
          ctx.lineTo(pts[i].x, pts[i].y);
          ctx.stroke();
        }
      }
    }

    requestAnimationFrame(draw);
  }
  draw();
})();
