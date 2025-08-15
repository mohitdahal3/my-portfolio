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









// ========== PROJECTS RENDERING FROM data.json ==========
(() => {
  const GRID_ID = 'projectGrid';
  const DATA_URL = './data.json';

  const grid = document.getElementById(GRID_ID);
  if (!grid) return;

  // Make sure grid items don't stretch to the tallest in the row
  // If grid is display:flex or display:grid, we'll enforce vertical centering
  grid.style.alignItems = 'center';

  // IntersectionObserver for fade-in-on-scroll
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.remove('opacity-0', 'translate-y-4');
        io.unobserve(e.target);
      }
    }
  }, { root: null, threshold: 0.15 });

  function createCard(project) {
    const { image, title, desc, buttons = [] } = project;

    // Outer wrapper (fade-in animation)
    const card = document.createElement('article');
    card.className = [
      'project-card',
      'w-[min(90vw,22rem)]',
      'opacity-0 translate-y-4',
      'transition duration-700 ease-out will-change-transform',
      'flex', 'flex-col', 'items-center' // allow vertical alignment
    ].join(' ');

    // Flow container so shadow + content have natural height
    const wrapper = document.createElement('div');
    wrapper.className = 'project-wrapper';

    // Shadow layer (keeps same border radius, but now flows naturally)
    const shadowDiv = document.createElement('div');
    shadowDiv.className = 'project-shadow';

    // Inner content (moves on hover)
    const inner = document.createElement('div');
    inner.className = 'project-inner p-4';

    // Image container
    const imgWrap = document.createElement('div');
    imgWrap.className = 'relative w-full pt-[75%] bg-neutral-900 overflow-hidden';

    const img = document.createElement('img');
    img.className = 'absolute inset-0 w-full h-full object-cover';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = title || 'Project image';
    img.src = image || '';
    img.onerror = () => {
      img.style.display = 'none';
      imgWrap.style.background =
        'linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))';
    };
    imgWrap.appendChild(img);

    // Content area
    const content = document.createElement('div');
    content.className = 'mt-3';

    const h3 = document.createElement('h3');
    h3.className = 'project-title text-2xl font-semibold mb-2';
    h3.textContent = title || 'Untitled';

    const p = document.createElement('p');
    p.className = 'project-desc text-white/80 text-base leading-relaxed mb-4';
    p.textContent = desc || '';

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.className = 'flex flex-wrap gap-3';
    (buttons || []).slice(0, 4).forEach((b) => {
      if (!b || (!b.text && !b.link)) return;
      const a = document.createElement('a');
      a.className = [
        'project-btn',
        'inline-flex items-center justify-center',
        'px-4 py-2 rounded-lg',
        'font-medium text-base',
        'ring-1 ring-white/30 hover:ring-white/70',
        'bg-white/0 hover:bg-white/10',
        'transition-colors'
      ].join(' ');
      a.textContent = b.text || 'Open';
      a.href = b.link || '#';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      btnRow.appendChild(a);
    });

    content.append(h3, p, btnRow);
    inner.append(imgWrap, content);

    // Assemble natural flow layout
    wrapper.append(shadowDiv, inner);
    card.append(wrapper);

    io.observe(card);
    return card;
  }

  async function loadProjects() {
    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`Failed to fetch ${DATA_URL}: ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('data.json must be an array');

      grid.textContent = '';
      data.forEach((proj) => grid.appendChild(createCard(proj)));
    } catch (err) {
      console.error(err);
      const fail = document.createElement('p');
      fail.className = 'text-center text-white/70';
      fail.textContent = 'Failed to load projects.';
      grid.replaceChildren(fail);
    }
  }

  loadProjects();
})();









// ========== DIRECTION-AWARE SECTION SNAP (Hero / Projects / Links) ==========
(() => {
  const sections = Array.from(document.querySelectorAll('section'));
  if (sections.length < 2) return;

  // Tunables
  const OVERLAP_FRAC = 0.05;  // how much of the neighbor must be visible to trigger snap
  const SNAP_DELAY_MS = 120;   // small debounce so we don't fight micro scrolls
  const SETTLE_FRAMES = 6;    // rAF frames with no movement -> animation done
  const NEAR_EPS_PX   = 2;    // close enough to target

  let lastY = window.scrollY;
  let direction = 'down';
  let animating = false;
  let snapTimer = null;
  let targetY = null;
  let rafId = null;

  const vh = () => window.innerHeight;

  function centerSectionIndex(rects) {
    const mid = vh() / 2;
    let idx = 0;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (r.top <= mid && r.bottom >= mid) {
        idx = i;
        break;
      }
      // fallback if none contains center (can happen at extreme edges)
      if (r.top > mid) { idx = Math.max(0, i - 1); break; }
      if (i === rects.length - 1) idx = i;
    }
    return idx;
  }

  function scheduleSnap(fn) {
    if (snapTimer) clearTimeout(snapTimer);
    snapTimer = setTimeout(fn, SNAP_DELAY_MS);
  }

  function scrollToY(y) {
    animating = true;
    targetY = Math.round(Math.max(0, y));
    window.scrollTo({ top: targetY, behavior: 'smooth' });
    watchSettle();
  }

  function watchSettle() {
    let stable = 0;
    let last = -1;

    function tick() {
      const y = Math.round(window.scrollY);
      if (y === last) stable++; else stable = 0;
      last = y;

      if (stable >= SETTLE_FRAMES || Math.abs(y - targetY) <= NEAR_EPS_PX) {
        animating = false;
        targetY = null;
        rafId = null;
        return;
      }
      rafId = requestAnimationFrame(tick);
    }

    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  function snapToNextTop(nextEl) {
    const y = nextEl.offsetTop; // align next section's top with viewport top
    scrollToY(y);
  }

  function snapToPrevBottom(prevEl) {
    const desired = prevEl.offsetTop + prevEl.offsetHeight - vh();
    // If the section is shorter than viewport, bottom-align would be above its top; clamp to top.
    const y = Math.max(prevEl.offsetTop, desired);
    scrollToY(y);
  }

  function onScroll() {
    const y = window.scrollY;
    const newDir = (y > lastY) ? 'down' : (y < lastY) ? 'up' : direction;
    if (newDir !== direction && snapTimer) {
      // if direction flips during debounce, cancel the pending snap
      clearTimeout(snapTimer);
      snapTimer = null;
    }
    direction = newDir;
    lastY = y;

    if (animating) return;

    const rects = sections.map(s => s.getBoundingClientRect());
    const i = centerSectionIndex(rects);

    const threshold = Math.max(8, Math.floor(vh() * OVERLAP_FRAC)); // px threshold

    if (direction === 'down' && i < sections.length - 1) {
      // How much of the next section is visible?
      const nextTop = rects[i + 1].top;     // px from viewport top
      const nextVisible = Math.max(0, vh() - Math.max(0, nextTop));
      if (nextVisible >= threshold) {
        scheduleSnap(() => snapToNextTop(sections[i + 1]));
      }
    } else if (direction === 'up' && i > 0) {
      // How much of the previous section is visible (at the top of viewport)?
      const prevBottom = rects[i - 1].bottom; // px from viewport top
      const prevVisible = Math.max(0, Math.min(prevBottom, vh())); // visible height at top
      if (prevVisible >= threshold) {
        scheduleSnap(() => snapToPrevBottom(sections[i - 1]));
      }
    }
  }

  // Passive so we don't block native scroll inside sections
  document.addEventListener('scroll', onScroll, { passive: true });

  // Re-evaluate on resize (layout/viewport changes)
  window.addEventListener('resize', () => {
    if (!animating) onScroll();
  }, { passive: true });

  // Nudge once on load (e.g., browser restores mid-page)
  window.addEventListener('load', () => {
    setTimeout(onScroll, 0);
  });
})();