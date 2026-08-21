// YouTube True Shuffle Toggle
// Adds a toggle button next to the native playlist shuffle button.
// When ON, this script decides which video to play next (a real
// Fisher-Yates random order), instead of YouTube's built-in shuffle.
// The actual playlist on YouTube's servers is never touched — only the
// local playback order in this browser tab.

(function () {
  const STORAGE_PREFIX = 'trueShuffle_';

  // Bumped whenever a bug could have written a bad order to storage. Saved
  // orders stamped with anything else are discarded rather than replayed —
  // v1 orders could contain videos that were never in the playlist (they
  // came from the "suggested videos" shelf on playlists you own).
  const ORDER_VERSION = 2;

  let state = { enabled: false, listId: null, order: [], pointer: -1 };
  let buttonEl = null;
  let hookedVideoEl = null;
  let advancing = false;
  let busy = false;
  // The video id WE asked for last. If the page ends up somewhere else while
  // shuffle is on, that tells us the jump did not come from this extension.
  let lastRequestedVideoId = null;

  // ---------- helpers ----------

  function getListIdFromUrl() {
    return new URL(location.href).searchParams.get('list');
  }

  function getVideoIdFromUrl() {
    return new URL(location.href).searchParams.get('v');
  }

  function fisherYates(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- reading the FULL playlist from YouTube's own page data ----------

  // The playlist panel in the DOM only ever holds the videos YouTube has
  // lazily rendered so far (~100), so scraping it shuffles a slice of a
  // long playlist instead of the whole thing. YouTube's own page data has
  // the complete list: the /playlist page embeds `ytInitialData` with the
  // first batch plus a continuation token, and the same InnerTube endpoint
  // the site itself calls returns the following batches. Both requests are
  // same-origin, so no extra host permission is needed.

  const MAX_CONTINUATION_PAGES = 60; // ~6000 videos, then we stop asking

  // Mixes / radio (list ids starting with RD) are generated on the fly and
  // effectively endless — there is no finite list to fetch.
  function isMixPlaylist(listId) {
    return !!listId && listId.startsWith('RD');
  }

  // Pulls the first balanced {...} block that follows `marker`. A regex
  // can't do this reliably: the JSON contains braces inside strings.
  function extractJsonAfter(text, marker) {
    const at = text.indexOf(marker);
    if (at === -1) return null;
    const start = text.indexOf('{', at);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  // Collecting every video-shaped renderer in the response is wrong: a
  // playlist page also carries OTHER video lists - most importantly the
  // "suggested videos to add" shelf YouTube shows on playlists you own.
  // Those are the same `lockupViewModel` type, so a naive sweep pulled them
  // into the shuffle and eventually navigated to a video that was never in
  // the playlist, while the list stayed active in the URL.
  //
  // The playlist itself is always the single largest array of video items in
  // the response; a suggestions shelf holds a handful by comparison. So we
  // score every array and keep only the winner, which needs no knowledge of
  // YouTube's current nesting.
  function videoIdOf(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.playlistVideoRenderer && node.playlistVideoRenderer.videoId) {
      return node.playlistVideoRenderer.videoId;
    }
    const lockup = node.lockupViewModel;
    if (lockup && lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && lockup.contentId) {
      return lockup.contentId;
    }
    return null;
  }

  function harvestVideoIds(node, seen, out) {
    let token = null;
    let best = null;
    let bestCount = 0;

    const visit = (n) => {
      if (!n || typeof n !== 'object') return;

      if (Array.isArray(n)) {
        let count = 0;
        n.forEach((child) => {
          if (videoIdOf(child)) count++;
        });
        if (count > bestCount) {
          bestCount = count;
          best = n;
        }
        n.forEach(visit);
        return;
      }

      if (n.continuationCommand && typeof n.continuationCommand.token === 'string') {
        token = n.continuationCommand.token;
      }
      Object.keys(n).forEach((k) => visit(n[k]));
    };

    visit(node);

    if (best) {
      best.forEach((child) => {
        const id = videoIdOf(child);
        if (id && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      });
    }

    return token;
  }

  async function fetchAllPlaylistVideoIds(listId) {
    const res = await fetch('/playlist?list=' + encodeURIComponent(listId), {
      credentials: 'include',
    });
    if (!res.ok) throw new Error('playlist page returned ' + res.status);
    const html = await res.text();

    const raw = extractJsonAfter(html, 'var ytInitialData');
    if (!raw) throw new Error('ytInitialData not found');

    const seen = new Set();
    const ids = [];
    let token = harvestVideoIds(JSON.parse(raw), seen, ids);

    const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
    const clientVersion = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1];

    let pages = 0;
    while (token && apiKey && clientVersion && pages < MAX_CONTINUATION_PAGES) {
      pages++;
      const r = await fetch('/youtubei/v1/browse?key=' + apiKey + '&prettyPrint=false', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion: clientVersion } },
          continuation: token,
        }),
      });
      if (!r.ok) break;
      const before = ids.length;
      token = harvestVideoIds(await r.json(), seen, ids);
      if (ids.length === before) break; // no progress — stop rather than loop
    }

    console.debug('[TrueShuffle] loaded', ids.length, 'videos in', pages + 1, 'request(s)');
    return ids;
  }

  function scrapePlaylistVideoIds() {
    const anchors = document.querySelectorAll(
      'ytd-playlist-panel-video-renderer a#wc-endpoint, ytd-playlist-panel-video-renderer a#thumbnail'
    );
    const ids = [];
    anchors.forEach((a) => {
      const href = a.getAttribute('href');
      if (!href) return;
      try {
        const u = new URL(href, location.origin);
        const vid = u.searchParams.get('v');
        if (vid && !ids.includes(vid)) ids.push(vid);
      } catch (e) {
        /* ignore malformed hrefs */
      }
    });
    return ids;
  }

  function storageKey(listId) {
    return STORAGE_PREFIX + listId;
  }

  function saveState() {
    if (!state.listId) return;
    chrome.storage.local.set({
      [storageKey(state.listId)]: {
        version: ORDER_VERSION,
        enabled: state.enabled,
        order: state.order,
        pointer: state.pointer,
      },
    });
  }

  function loadState(listId, cb) {
    chrome.storage.local.get([storageKey(listId)], (res) => {
      const saved = res[storageKey(listId)];
      if (!saved || saved.version !== ORDER_VERSION) {
        // Stale or suspect: start clean instead of replaying a bad order.
        cb(null);
        return;
      }
      cb(saved);
    });
  }

  function navigateTo(videoId) {
    if (!videoId) return;

    // Pausing first is what actually settles the race. While the video is
    // still running, YouTube has its own end-of-video handler queued; if our
    // navigation lands mid-transition it can be discarded and YouTube's
    // choice wins instead. A paused video never reaches that handler.
    const video = document.querySelector('video');
    if (video) {
      try {
        video.pause();
      } catch (e) {
        /* player already torn down */
      }
    }

    lastRequestedVideoId = videoId;
    const listId = state.listId;
    const target = `/watch?v=${videoId}${listId ? '&list=' + listId : ''}`;
    // Click a real same-origin link so YouTube's SPA router handles the
    // navigation (fast, no full page reload) instead of a hard redirect.
    const a = document.createElement('a');
    a.href = target;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function advance() {
    if (!state.enabled || state.order.length === 0) return;
    // YouTube's own autoplay, the next button and our 'timeupdate' watcher
    // can all try to move on within the same second. Without this guard the
    // playlist would skip two or three videos at once.
    if (advancing) return;
    advancing = true;
    setTimeout(() => {
      advancing = false;
    }, 3000);
    state.pointer += 1;
    if (state.pointer >= state.order.length) {
      // Completed a full pass through the playlist — reshuffle for the
      // next lap so it doesn't just repeat the same cycle.
      state.order = fisherYates(state.order);
      state.pointer = 0;
    }
    saveState();
    navigateTo(state.order[state.pointer]);
  }

  async function enableShuffle() {
    let ids = [];
    if (!isMixPlaylist(state.listId)) {
      setBusy(true);
      try {
        ids = await fetchAllPlaylistVideoIds(state.listId);
      } catch (e) {
        console.debug('[TrueShuffle] full playlist fetch failed:', e);
      }
      setBusy(false);
    }
    // Fallback for mixes, private edge cases, or a YouTube data change:
    // shuffle whatever the panel has rendered rather than doing nothing.
    if (ids.length === 0) ids = scrapePlaylistVideoIds();
    if (ids.length === 0) return false;

    let order = fisherYates(ids);
    const currentVid = getVideoIdFromUrl();
    const idx = order.indexOf(currentVid);
    if (idx > 0) {
      // Keep whatever is currently playing as the starting point, so
      // turning shuffle on doesn't yank you to a different video.
      order.splice(idx, 1);
      order.unshift(currentVid);
    }

    state.enabled = true;
    state.order = order;
    state.pointer = 0;
    saveState();
    updateButtonUI();
    hookVideoElement();
    return true;
  }

  function disableShuffle() {
    state.enabled = false;
    saveState();
    updateButtonUI();
  }

  function toggleShuffle() {
    if (busy) return;
    if (state.enabled) {
      disableShuffle();
    } else {
      enableShuffle();
    }
  }

  // ---------- UI ----------

  function setBusy(value) {
    busy = value;
    if (buttonEl) buttonEl.classList.toggle('true-shuffle-busy', value);
  }

  function updateButtonUI() {
    if (!buttonEl) return;
    buttonEl.classList.toggle('true-shuffle-active', state.enabled);
    buttonEl.setAttribute('aria-pressed', state.enabled ? 'true' : 'false');
    buttonEl.setAttribute('aria-label', 'True Shuffle');
    const count = state.order.length;
    buttonEl.title = state.enabled
      ? 'True Shuffle: ON — ' + count + ' videos in a real random order. Click to turn off.'
      : 'True Shuffle: OFF — click for a real random order over the whole playlist';
  }

  // aria-label text is translated per UI language (e.g. Ukrainian uses
  // "Перемішати список відтворення", not the English "Shuffle"), so it
  // can't cover every locale by itself. YouTube's own renderer data calls
  // this control iconType "SHUFFLE" — that internal identifier is NOT
  // translated, and it's what ends up in the DOM as the icon's `icon`
  // attribute (e.g. "shuffle" / "yt-icons:shuffle") regardless of what
  // language the page is displayed in. So we match on that first, and
  // only fall back to translated text for older/alternate markup.
  const SHUFFLE_LABELS = [
    'Shuffle', 'Перемішати', 'Перемешать', 'Melanger', 'Aleatorio',
    'Aleatorio', 'Zufallig', 'Casuale', 'Willekeurig', 'Losowo',
    'Karistir', 'Nahodne', 'Veletlenszeru', 'Redzati', 'Blanda',
    'Tilfeldig', 'Satunnainen', 'シャッフル', '셔플', '随机播放', '隨機播放',
    'สุ่ม', 'Xao tron', 'Acak', 'خلط', 'ערבוב',
  ];

  // YouTube's UI is built from many custom elements, most of which use
  // *shadow DOM*. A plain document.querySelector('ytd-playlist-panel-renderer
  // button') can only see as far as the first shadow boundary — it does
  // NOT reach into shadow roots, even open ones. That's why every selector
  // above kept missing the button: it genuinely lives a few shadow trees
  // deep and a light-DOM-only selector can never reach it. deepQueryAll
  // walks into every open shadow root so the same selector strings can
  // actually find their target.
  function deepQueryAll(selector, root) {
    const out = [];
    const scan = (node) => {
      if (!node || !node.querySelectorAll) return;
      let matches;
      try {
        matches = node.querySelectorAll(selector);
      } catch (e) {
        return; // selector unsupported (e.g. :has() on older engines)
      }
      matches.forEach((el) => out.push(el));
      node.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) scan(el.shadowRoot);
      });
    };
    scan(root || document);
    return out;
  }

  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function findAnchorContainer() {
    // Try several known/likely locations for the native shuffle control,
    // since YouTube's markup changes over time and differs by layout.
    const selectors = [
      // Language-independent: match on the internal icon identifier
      // rather than any translated text.
      '[icon*="shuffle" i]',
      'yt-icon[icon-name*="shuffle" i]',
      'button:has([icon*="shuffle" i])',
      'button:has(svg [id*="shuffle" i])',
      'button:has(svg use[href*="shuffle" i])',
      '[class*="shuffle" i]',
      // Language-dependent fallback, in case the icon identifier ever
      // differs from what's above.
      ...SHUFFLE_LABELS.map((label) => `button[aria-label*="${label}" i]`),
      'yt-icon-button#header-shuffle-off',
    ];
    for (const sel of selectors) {
      const matches = deepQueryAll(sel);
      for (const el of matches) {
        if (!isVisible(el)) continue;
        // Only trust matches that are actually part of the playlist
        // panel, not some unrelated shuffle-labelled control elsewhere
        // on the page (e.g. a "Mix" shuffle button in a sidebar module).
        if (!el.closest('ytd-playlist-panel-renderer')) continue;
        const btn = el.matches && el.matches('button') ? el : el.closest('button') || el;
        const container = btn.parentElement;
        if (container) {
          console.debug('[TrueShuffle] anchoring near', sel, el);
          return container;
        }
      }
    }
    // Fully language-independent structural fallback: the row that holds
    // the playlist panel's top-level buttons (shuffle, loop, menu).
    const structural = deepQueryAll(
      'ytd-playlist-panel-renderer #top-level-buttons-computed, ytd-playlist-panel-renderer #menu, ytd-playlist-panel-renderer #header'
    ).find(isVisible);
    if (structural) {
      console.debug('[TrueShuffle] anchoring via structural fallback');
      return structural;
    }
    console.debug('[TrueShuffle] no native shuffle container found, using floating fallback');
    return null;
  }

  function createButton() {
    const btn = document.createElement('button');
    btn.id = 'true-shuffle-toggle-btn';
    btn.type = 'button';
    // Inline SVG instead of the emoji: the icon can be sized and coloured
    // freely and stays crisp, while the label shrinks to just "TRUE" so the
    // button stays compact next to YouTube's own controls.
    btn.innerHTML =
      '<svg class="true-shuffle-icon" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M2.8 6.5h4.4L16 15.9M2.8 17.5h4.4L16 8.1" fill="none" ' +
      'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
      'stroke-linejoin="round"/>' +
      '<path d="M15.4 12.4 21.2 15.9 15.4 19.4zM15.4 4.6 21.2 8.1 15.4 11.6z" ' +
      'fill="currentColor"/></svg>' +
      '<span class="true-shuffle-label">TRUE</span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleShuffle();
    });
    return btn;
  }

  function insertButton() {
    if (!getListIdFromUrl()) return; // only show inside a playlist
    if (buttonEl && document.body.contains(buttonEl)) {
      updateButtonUI();
      return;
    }

    const container = findAnchorContainer();
    buttonEl = createButton();

    if (container) {
      buttonEl.classList.remove('true-shuffle-floating');
      container.appendChild(buttonEl);
    } else {
      // Guaranteed-visible fallback: fixed position, independent of
      // YouTube's current DOM structure. This always shows up.
      buttonEl.classList.add('true-shuffle-floating');
      document.body.appendChild(buttonEl);
    }
    updateButtonUI();
  }

  // ---------- intercepting native "next" behavior ----------

  // YouTube starts loading the next playlist item slightly before the
  // current one fires 'ended', so waiting for 'ended' alone often loses the
  // race and the native order wins. Stepping in a fraction of a second
  // early keeps our order in control. The 'ended' listener stays as a
  // backstop for videos that jump straight to the end.
  const ADVANCE_LEAD_SECONDS = 0.4;

  function hookVideoElement() {
    const video = document.querySelector('video');
    if (!video || video === hookedVideoEl) return;
    hookedVideoEl = video;

    video.addEventListener('ended', () => {
      if (state.enabled) advance();
    });

    video.addEventListener('timeupdate', () => {
      if (!state.enabled) return;
      const d = video.duration;
      if (!d || !isFinite(d)) return;
      if (d - video.currentTime <= ADVANCE_LEAD_SECONDS) advance();
    });
  }

  // YouTube's keyboard shortcut for "next video" (Shift+N) bypasses the
  // player buttons entirely, so it needs intercepting separately.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!state.enabled) return;
      if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key !== 'N' && e.key !== 'n') return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      e.preventDefault();
      e.stopPropagation();
      advance();
    },
    true
  );

  document.addEventListener(
    'click',
    (e) => {
      if (!state.enabled) return;
      // Only override the player's own "next" arrow. Clicking a specific
      // video inside the playlist panel still works normally.
      const nextBtn = e.target.closest('.ytp-next-button');
      if (nextBtn) {
        e.preventDefault();
        e.stopPropagation();
        advance();
      }
    },
    true
  );

  // A few bounded retries after each navigation, in case the playlist
  // panel's shadow DOM hasn't finished rendering yet when the navigation
  // event fires. This is NOT continuous polling — it only runs a handful
  // of times right after a real page update, then stops.
  let anchorRetryTimers = [];
  function scheduleAnchorRetries() {
    anchorRetryTimers.forEach((t) => clearTimeout(t));
    anchorRetryTimers = [500, 1500, 3000].map((delay) =>
      setTimeout(() => {
        if (!getListIdFromUrl()) return;
        if (buttonEl && buttonEl.classList.contains('true-shuffle-floating')) {
          const container = findAnchorContainer();
          if (container) {
            buttonEl.classList.remove('true-shuffle-floating');
            container.appendChild(buttonEl);
            updateButtonUI();
          }
        }
        hookVideoElement();
      }, delay)
    );
  }

  // ---------- SPA navigation handling ----------

  // Says out loud, in the page console, who is responsible when playback
  // ends up on a video that is not in the shuffled order. Without this the
  // two possible causes — a bad entry in our order, or YouTube's autoplay
  // overriding us — look identical from the outside.
  function auditLanding() {
    if (!state.enabled || state.order.length === 0) return;
    const vid = getVideoIdFromUrl();
    if (!vid || state.order.indexOf(vid) !== -1) return;

    if (vid === lastRequestedVideoId) {
      console.warn(
        '[TrueShuffle] this extension navigated to %s, which is NOT in the ' +
          'shuffled order — the order itself is contaminated.',
        vid
      );
    } else {
      console.warn(
        '[TrueShuffle] playback moved to %s on its own (we last asked for %s). ' +
          'YouTube overrode the shuffled order — not an order problem.',
        vid,
        lastRequestedVideoId
      );
    }
  }

  function onNavigate() {
    advancing = false;
    const listId = getListIdFromUrl();

    if (!listId) {
      state = { enabled: false, listId: null, order: [], pointer: -1 };
      if (buttonEl) {
        buttonEl.remove();
        buttonEl = null;
      }
      return;
    }

    if (state.listId !== listId) {
      state.listId = listId;
      loadState(listId, (saved) => {
        if (saved) {
          state.enabled = saved.enabled;
          state.order = saved.order;
          state.pointer = saved.pointer;
        } else {
          state.enabled = false;
          state.order = [];
          state.pointer = -1;
        }
        updateButtonUI();
        if (state.enabled) hookVideoElement();
      });
    }

    insertButton();
    hookVideoElement();
    scheduleAnchorRetries();
    auditLanding();
  }

  // Only re-run the check when the page actually updates: a full reload
  // ('load') or YouTube's SPA route change ('yt-navigate-finish'). No
  // continuous polling (no MutationObserver, no setInterval) — that was
  // wasting CPU by re-checking on every DOM mutation / every 2s regardless
  // of whether anything relevant changed.
  document.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('load', onNavigate);

  onNavigate();
})();
