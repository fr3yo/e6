/*
  TikTok-style e621 viewer (feed scroll container)
  Fixes:
  - Mobile drift/misalignment: feed is the scroll container + 100dvh/100svh cards
  - Mobile hard snap: swipe or wheel moves exactly one post
  - Prevent jump to newest loaded: overflow-anchor none + prune adjusts scrollTop
*/

const feed = document.getElementById('feed');

const POSTS_PER_PAGE = 10;
const DEFAULT_TAGS = 'order:score rating:s';

const KEEP_BEHIND = 10;
const PRELOAD_AHEAD = 5;

let currentPage = 1;
let loading = false;
let isForceScrolling = false;
let isMobile = false;

function escapeHtml(s) {
  return (s ?? '').toString()
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getCards() {
  return Array.from(feed.querySelectorAll('.post-card'));
}

function getCurrentIndexInFeed() {
  const cards = getCards();
  if (!cards.length) return 0;

  const mid = feed.scrollTop + (feed.clientHeight / 2);

  let best = 0;
  let bestDist = Infinity;

  cards.forEach((c, i) => {
    const center = c.offsetTop + (c.offsetHeight / 2);
    const dist = Math.abs(center - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });

  return best;
}

function scrollToCardIndex(i) {
  const cards = getCards();
  if (!cards.length) return;

  const idx = Math.max(0, Math.min(i, cards.length - 1));
  const target = cards[idx];

  isForceScrolling = true;
  feed.scrollTo({
    top: target.offsetTop,
    behavior: 'smooth'
  });

  setTimeout(() => { isForceScrolling = false; }, 260);

  setTimeout(() => {
    ensurePreload();
    pruneAroundCurrent();
  }, 360);
}

// -------------------------
// Fetch posts
// -------------------------
async function fetchPosts() {
  if (loading) return;
  loading = true;

  try {
    const resp = await fetch(`/api/posts?tags=${encodeURIComponent(DEFAULT_TAGS)}&page=${currentPage}&limit=${POSTS_PER_PAGE}`);
    const data = await resp.json();
    const posts = data?.posts || [];

    if (!Array.isArray(posts) || posts.length === 0) {
      loading = false;
      return;
    }

    // IMPORTANT: do NOT scroll when new posts are appended
    for (const post of posts) {
      if ((post?.file?.ext || '').toLowerCase() === 'swf') continue;
      addPost(post);
    }

    currentPage += 1;
  } catch {
    // ignore
  } finally {
    loading = false;
  }
}

// -------------------------
// Render post
// -------------------------
function addPost(post) {
  const card = document.createElement('div');
  card.className = 'post-card';
  card.dataset.postId = post.id;

  const ext = (post?.file?.ext || '').toLowerCase();
  const url = post?.file?.url;

  const isVideo = ['webm', 'mp4'].includes(ext);

  let mediaEl;
  if (url) {
    if (isVideo) {
      const v = document.createElement('video');
      v.src = url;
      v.controls = true;
      v.playsInline = true;
      v.loop = true;
      v.muted = true;
      mediaEl = v;
    } else {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      mediaEl = img;
    }
  } else {
    const missing = document.createElement('div');
    missing.style.padding = '2rem';
    missing.textContent = 'Missing media URL';
    mediaEl = missing;
  }
  card.appendChild(mediaEl);

  const artists = post?.tags?.artist || [];
  const artistText = artists.length ? artists.join(', ') : 'unknown';

  const up = post?.score?.up ?? 0;
  const down = post?.score?.down ?? 0;
  const total = post?.score?.total ?? (up - down);

  const desc = post?.description ? post.description : '';
  const commentCount = post?.comment_count ?? 0;

  const info = document.createElement('div');
  info.className = 'post-info';
  info.innerHTML = `
    <div><strong>Artist:</strong> ${escapeHtml(artistText)}</div>
    <div><strong>Score:</strong> ${total} (⬆ ${up} / ⬇ ${down})</div>
    <div><strong>Comments:</strong> ${commentCount}</div>
    ${desc ? `<div style="margin-top:6px; opacity:0.95;">${escapeHtml(desc).slice(0, 300)}</div>` : ''}
  `;
  card.appendChild(info);

  const btns = document.createElement('div');
  btns.className = 'action-buttons';

  const upBtn = document.createElement('button');
  upBtn.className = 'action-button';
  upBtn.textContent = '👍';
  upBtn.onclick = () => vote(post.id, 1);

  const downBtn = document.createElement('button');
  downBtn.className = 'action-button';
  downBtn.textContent = '👎';
  downBtn.onclick = () => vote(post.id, -1);

  const favBtn = document.createElement('button');
  favBtn.className = 'action-button';
  favBtn.textContent = '⭐';
  favBtn.onclick = () => favorite(post.id);

  const comBtn = document.createElement('button');
  comBtn.className = 'action-button';
  comBtn.textContent = '💬';
  comBtn.onclick = () => toggleComments(card, post.id);

  btns.appendChild(upBtn);
  btns.appendChild(downBtn);
  btns.appendChild(favBtn);
  btns.appendChild(comBtn);

  card.appendChild(btns);

  feed.appendChild(card);
}

// -------------------------
// Actions
// -------------------------
async function vote(postId, score) {
  try {
    await fetch(`/api/posts/${postId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score })
    });
  } catch {}
}

async function favorite(postId) {
  try {
    await fetch(`/api/favorites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: postId })
    });
  } catch {}
}

// -------------------------
// Comments
// -------------------------
async function toggleComments(card, postId) {
  let panel = card.querySelector('.comments-panel');

  if (panel && panel.classList.contains('open')) {
    panel.classList.remove('open');
    card.classList.remove('comments-open');

    if (card._outsideTapHandler) {
      document.removeEventListener('click', card._outsideTapHandler, true);
      card._outsideTapHandler = null;
    }
    return;
  }

  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'comments-panel';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'comments-close';
    closeBtn.textContent = '×';
    closeBtn.onclick = () => toggleComments(card, postId);
    panel.appendChild(closeBtn);

    const header = document.createElement('div');
    header.className = 'comments-header';
    header.textContent = 'Comments';
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'comments-body';
    body.innerHTML = `<div class="comments-loading">Loading comments…</div>`;
    panel.appendChild(body);

    card.appendChild(panel);
  }

  card.classList.add('comments-open');
  panel.classList.add('open');

  if (isMobile) {
    const handler = (ev) => {
      if (!panel.contains(ev.target)) toggleComments(card, postId);
    };
    card._outsideTapHandler = handler;
    document.addEventListener('click', handler, true);
  }

  const bodyEl = panel.querySelector('.comments-body');
  bodyEl.innerHTML = `<div class="comments-loading">Loading comments…</div>`;

  try {
    const r = await fetch(`/api/comments/${postId}`);
    const data = await r.json();

    if (!r.ok) {
      const dbg = data?.debug ? `\n\nDebug:\n${JSON.stringify(data.debug, null, 2)}` : '';
      bodyEl.innerHTML = `<div class="comments-error">Failed to load comments.${dbg}</div>`;
      return;
    }

    if (!Array.isArray(data) || data.length === 0) {
      bodyEl.innerHTML = `<div class="comments-empty">No comments.</div>`;
      return;
    }

    bodyEl.innerHTML = '';
    for (const c of data) {
      const row = document.createElement('div');
      row.className = 'comment';

      if (c.avatar_url) {
        const img = document.createElement('img');
        img.className = 'comment-avatar';
        img.src = c.avatar_url;
        img.alt = '';
        row.appendChild(img);
      }

      const text = document.createElement('div');
      text.className = 'comment-text';

      const name = document.createElement('div');
      name.className = 'comment-author';
      name.textContent = c.creator_name || 'Unknown';

      const msg = document.createElement('div');
      msg.className = 'comment-body';
      msg.textContent = c.body || '';

      text.appendChild(name);
      text.appendChild(msg);

      row.appendChild(text);
      bodyEl.appendChild(row);
    }
  } catch (e) {
    bodyEl.innerHTML = `<div class="comments-error">Failed to load comments.\n${String(e)}</div>`;
  }
}

// -------------------------
// Preload + prune (NO JUMP)
// -------------------------
function ensurePreload() {
  const cards = getCards();
  const idx = getCurrentIndexInFeed();
  const ahead = cards.length - idx - 1;

  if (ahead < PRELOAD_AHEAD) fetchPosts();
}

/*
  Critical fix: when removing cards ABOVE the current one, adjust feed.scrollTop
  by the removed height so the view does not “jump” to the newest loaded post.
*/
function pruneAroundCurrent() {
  const cards = getCards();
  if (cards.length === 0) return;

  const idx = getCurrentIndexInFeed();
  const min = Math.max(0, idx - KEEP_BEHIND);
  const max = Math.min(cards.length - 1, idx + PRELOAD_AHEAD);

  let removedAboveHeight = 0;

  // Remove below range first (no scrollTop impact)
  for (let i = cards.length - 1; i >= 0; i--) {
    if (i > max) {
      cards[i].remove();
    }
  }

  // Recompute after removals
  const cards2 = getCards();

  // Remove above range while tracking height
  for (let i = 0; i < cards2.length; i++) {
    if (i < min) {
      removedAboveHeight += cards2[i].offsetHeight;
      if (cards2[i]._outsideTapHandler) {
        document.removeEventListener('click', cards2[i]._outsideTapHandler, true);
        cards2[i]._outsideTapHandler = null;
      }
      cards2[i].remove();
    }
  }

  if (removedAboveHeight > 0) {
    feed.scrollTop = Math.max(0, feed.scrollTop - removedAboveHeight);
  }
}

// -------------------------
// Desktop wheel: one gesture = one post
// -------------------------
feed.addEventListener('wheel', (e) => {
  if (isMobile) return;
  if (isForceScrolling) return;
  if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
  if (Math.abs(e.deltaY) < 12) return;

  e.preventDefault();

  const idx = getCurrentIndexInFeed();
  scrollToCardIndex(e.deltaY > 0 ? idx + 1 : idx - 1);
}, { passive: false });

// Arrow keys: one press = one post
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    scrollToCardIndex(getCurrentIndexInFeed() + 1);
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    scrollToCardIndex(getCurrentIndexInFeed() - 1);
  }
});

// -------------------------
// Mobile swipe: one swipe = one post (hard snap)
// -------------------------
let touchStartY = null;

feed.addEventListener('touchstart', (e) => {
  if (!isMobile) return;
  if (!e.touches || !e.touches[0]) return;
  touchStartY = e.touches[0].clientY;
}, { passive: true });

feed.addEventListener('touchend', (e) => {
  if (!isMobile) return;
  if (touchStartY == null) return;

  const endY = (e.changedTouches && e.changedTouches[0])
    ? e.changedTouches[0].clientY
    : touchStartY;

  const dy = endY - touchStartY;
  touchStartY = null;

  const idx = getCurrentIndexInFeed();
  const THRESH = 6;

  if (Math.abs(dy) < THRESH) {
    scrollToCardIndex(idx);
  } else if (dy < 0) {
    scrollToCardIndex(idx + 1);
  } else {
    scrollToCardIndex(idx - 1);
  }
}, { passive: true });

// -------------------------
// Boot
// -------------------------
document.addEventListener('DOMContentLoaded', () => {
  isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  if (isMobile) document.body.classList.add('mobile');

  fetchPosts();

  // Lightweight: preload/prune while scrolling, but NEVER snap here
  feed.addEventListener('scroll', () => {
    if (isForceScrolling) return;
    ensurePreload();
    pruneAroundCurrent();
  }, { passive: true });
});
