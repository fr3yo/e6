const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const AVATAR_LOOKUP_LIMIT = 10;

// Serve static files
app.use(express.static('public'));
app.use(bodyParser.json());

// Credentials from env (recommended)
const DEFAULT_LOGIN = process.env.E621_LOGIN || null;
const DEFAULT_API_KEY = process.env.E621_API_KEY || null;

// Helper: build headers (User-Agent required by e621)
function buildHeaders() {
  const headers = {
    'User-Agent': `LocalE621Viewer/1.0 (by ${DEFAULT_LOGIN || 'unknown'} on e621)`,
    'Accept': 'application/json',
  };

  // Use Basic auth when possible
  if (DEFAULT_LOGIN && DEFAULT_API_KEY) {
    const token = Buffer.from(`${DEFAULT_LOGIN}:${DEFAULT_API_KEY}`).toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  }
  return headers;
}

// -----------------------------
// POSTS (proxy)
// -----------------------------
app.get('/api/posts', async (req, res) => {
  const tags = req.query.tags || '';
  const page = req.query.page || 1;
  const limit = req.query.limit || 10;

  // Always exclude Flash (SWF)
  const finalTags = `${tags} -type:swf`;
  const url = `https://e621.net/posts.json?tags=${encodeURIComponent(finalTags)}&page=${page}&limit=${limit}`;

  try {
    const response = await fetch(url, { headers: buildHeaders() });
    const data = await response.json();

    if (data && Array.isArray(data.posts)) {
      data.posts = data.posts.filter(p => (p?.file?.ext || '').toLowerCase() !== 'swf');
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch posts.' });
  }
});

// -----------------------------
// VOTE (proxy)
// -----------------------------
app.post('/api/posts/:id/vote', async (req, res) => {
  const { id } = req.params;
  let { score, login, api_key } = req.body;

  login = DEFAULT_LOGIN || login;
  api_key = DEFAULT_API_KEY || api_key;

  try {
    const response = await fetch(`https://e621.net/posts/${id}/votes.json`, {
      method: 'POST',
      headers: {
        ...buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ score, login, api_key }),
    });

    const result = await response.json();
    res.status(response.status).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Vote failed.' });
  }
});

// -----------------------------
// FAVORITE (proxy)
// -----------------------------
app.post('/api/favorites', async (req, res) => {
  let { post_id, login, api_key } = req.body;

  login = DEFAULT_LOGIN || login;
  api_key = DEFAULT_API_KEY || api_key;

  try {
    const response = await fetch('https://e621.net/favorites.json', {
      method: 'POST',
      headers: {
        ...buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ post_id, login, api_key }),
    });

    const result = await response.json();
    res.status(response.status).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Favorite failed.' });
  }
});

app.delete('/api/favorites/:id', async (req, res) => {
  const { id } = req.params;
  let { login, api_key } = req.body;

  login = DEFAULT_LOGIN || login;
  api_key = DEFAULT_API_KEY || api_key;

  try {
    const response = await fetch(`https://e621.net/favorites/${id}.json`, {
      method: 'DELETE',
      headers: {
        ...buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ login, api_key }),
    });

    const result = await response.json();
    res.status(response.status).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Unfavorite failed.' });
  }
});

// -----------------------------
// COMMENTS (robust proxy + debug)
// -----------------------------
app.get('/api/comments/:postId', async (req, res) => {
  const postId = req.params.postId;
  const headers = buildHeaders();

  const urls = [
    `https://e621.net/posts/${postId}/comments.json`,
    `https://e621.net/comments.json?post_id=${postId}`,
    `https://e621.net/comments.json?search%5Bpost_id%5D=${postId}`,
  ];

  try {
    let lastErr = null;

    for (const url of urls) {
      try {
        const r = await fetch(url, { headers });
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        const text = await r.text();

        if (!r.ok) {
          lastErr = { url, status: r.status, contentType: ct, snippet: text.slice(0, 250) };
          continue;
        }

        let payload = null;
        try {
          payload = JSON.parse(text);
        } catch {
          lastErr = { url, status: r.status, contentType: ct, snippet: text.slice(0, 250) };
          continue;
        }

        const comments = Array.isArray(payload) ? payload : (payload.comments || []);
        if (!Array.isArray(comments)) {
          lastErr = { url, status: r.status, contentType: ct, snippet: text.slice(0, 250) };
          continue;
        }

        const limited = comments.slice(0, 50);
        const results = limited.map(c => ({
          id: c.id,
          body: c.body || c.body_html || '',
          creator_id: c.creator_id || null,
          creator_name: c.creator_name || c.author || 'Unknown',
          avatar_url: null
        }));

        // Enrich avatars (best-effort, limited to avoid stalling comment loads)
        const avatarIds = Array.from(new Set(results
          .map(item => item.creator_id)
          .filter(Boolean)))
          .slice(0, AVATAR_LOOKUP_LIMIT);

        if (avatarIds.length) {
          const avatars = await Promise.all(avatarIds.map(async (creatorId) => {
            try {
              const ur = await fetch(`https://e621.net/users/${creatorId}.json`, { headers, timeout: 6000 });
              if (!ur.ok) return [creatorId, null];

              const uText = await ur.text();
              let uJson = null;
              try { uJson = JSON.parse(uText); } catch { return [creatorId, null]; }

              const u = uJson.user || uJson;
              return [creatorId, u?.avatar_url || u?.avatar?.url || u?.avatar || null];
            } catch {
              return [creatorId, null];
            }
          }));

          const avatarMap = Object.fromEntries(avatars);
          for (const item of results) {
            if (item.creator_id && avatarMap[item.creator_id]) {
              item.avatar_url = avatarMap[item.creator_id];
            }
          }
        }

        return res.json(results);
      } catch (e) {
        lastErr = { url, error: String(e) };
      }
    }

    return res.status(502).json({
      error: 'Failed to retrieve comments from upstream.',
      debug: lastErr,
    });
  } catch (e) {
    console.error('Error fetching comments:', e);
    return res.status(500).json({ error: 'Failed to fetch comments.' });
  }
});

// -----------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
