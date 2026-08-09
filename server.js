require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SpotifyWebApi = require('spotify-web-api-node');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const REQUIRED_ENV = [
  'SESSION_SECRET',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_REDIRECT_URI'
];

const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length) {
  console.error(`Missing required environment variable(s): ${missingEnv.join(', ')}`);
  process.exit(1);
}

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_BASE_URL = 'https://ws.audioscrobbler.com/2.0/';

if (!LASTFM_API_KEY) {
  console.warn('LASTFM_API_KEY is not set — /api/lastfm/* routes will return errors until it is configured.');
}

// Persists Last.fm usernames keyed by Spotify user ID, so a person only has
// to link Last.fm once — not once per 7-day session.
//
// Two backends, chosen automatically:
//  - DATABASE_URL set (e.g. Render Postgres)  -> Postgres, survives deploys/restarts
//  - DATABASE_URL not set (local dev default) -> a JSON file on disk
//
// The JSON file is fine for local development, but on most free hosts
// (including Render's free web service tier) the filesystem is wiped on
// every deploy and every sleep/wake cycle — so production should always
// have DATABASE_URL set.
const DATA_DIR = path.join(__dirname, 'data');
const LASTFM_LINKS_FILE = path.join(DATA_DIR, 'lastfm-links.json');
const usingPostgres = !!process.env.DATABASE_URL;

const pool = usingPostgres
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      // Render's managed Postgres requires SSL but uses a self-signed
      // cert chain that Node won't validate by default.
      ssl: { rejectUnauthorized: false }
    })
  : null;

async function initLastfmStore() {
  if (!usingPostgres) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lastfm_links (
      spotify_user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL
    )
  `);
}

function loadLastfmLinksFile() {
  try {
    return JSON.parse(fs.readFileSync(LASTFM_LINKS_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Could not read lastfm-links.json, starting fresh:', err.message);
    }
    return {};
  }
}

function saveLastfmLinksFile(links) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LASTFM_LINKS_FILE, JSON.stringify(links, null, 2));
  } catch (err) {
    console.error('Could not save lastfm-links.json:', err.message);
  }
}

// In-memory cache used only by the JSON-file backend, loaded once at
// startup. The Postgres backend ignores this entirely and hits the DB
// directly on every call.
let jsonLinksCache = usingPostgres ? null : loadLastfmLinksFile();

async function getLastfmUsername(spotifyUserId) {
  if (usingPostgres) {
    const { rows } = await pool.query(
      'SELECT username FROM lastfm_links WHERE spotify_user_id = $1',
      [spotifyUserId]
    );
    return rows[0]?.username || null;
  }
  return jsonLinksCache[spotifyUserId] || null;
}

async function setLastfmUsername(spotifyUserId, username) {
  if (usingPostgres) {
    await pool.query(
      `INSERT INTO lastfm_links (spotify_user_id, username) VALUES ($1, $2)
       ON CONFLICT (spotify_user_id) DO UPDATE SET username = EXCLUDED.username`,
      [spotifyUserId, username]
    );
    return;
  }
  jsonLinksCache[spotifyUserId] = username;
  saveLastfmLinksFile(jsonLinksCache);
}

async function deleteLastfmUsername(spotifyUserId) {
  if (usingPostgres) {
    await pool.query('DELETE FROM lastfm_links WHERE spotify_user_id = $1', [spotifyUserId]);
    return;
  }
  delete jsonLinksCache[spotifyUserId];
  saveLastfmLinksFile(jsonLinksCache);
}

// Thin wrapper around Last.fm's REST API (method + params -> parsed JSON).
// Last.fm returns HTTP 200 with an `error` field for most failures (bad
// username, unknown method, etc.), so we check that explicitly rather than
// relying on response.ok.
async function lastfmRequest(params) {
  if (!LASTFM_API_KEY) {
    const err = new Error('Last.fm API key is not configured on the server');
    err.statusCode = 500;
    throw err;
  }

  const url = new URL(LASTFM_BASE_URL);
  url.searchParams.set('api_key', LASTFM_API_KEY);
  url.searchParams.set('format', 'json');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url);
  const data = await response.json();

  if (data.error) {
    const err = new Error(data.message || 'Last.fm API error');
    err.statusCode = 400;
    throw err;
  }

  return data;
}

const app = express();

app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    secure: process.env.NODE_ENV === 'production'
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

const ALLOWED_TIME_RANGES = ['short_term', 'medium_term', 'long_term'];

function createSpotifyClient() {
  return new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: process.env.SPOTIFY_REDIRECT_URI
  });
}

// Wraps async route handlers so rejected promises reach Express's error
// handler instead of crashing the process.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.get('/login', (req, res) => {
  const scopes = [
    'user-read-email',
    'user-read-private',
    'user-top-read',
    'user-read-recently-played',
    'streaming',
    'user-read-playback-state',
    'user-modify-playback-state'
  ];

  const authorizeURL = createSpotifyClient().createAuthorizeURL(scopes);
  res.redirect(authorizeURL);
});

app.get('/callback', asyncHandler(async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`Auth error: ${error}`);
  }

  const client = createSpotifyClient();

  try {
    const data = await client.authorizationCodeGrant(code);

    req.session.accessToken = data.body.access_token;
    req.session.refreshToken = data.body.refresh_token;
    req.session.expiresAt = Date.now() + data.body.expires_in * 1000;

    // Capture the Spotify user ID now so /api/lastfm/* can key persisted
    // links off it without an extra round trip on every request.
    client.setAccessToken(data.body.access_token);
    const me = await client.getMe();
    req.session.spotifyUserId = me.body.id;

    res.redirect('/');
  } catch (err) {
    console.error('Authorization code grant failed:', err.message);
    res.status(400).send('Auth error: ' + err.message);
  }
}));

app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error('Session destroy failed:', err.message);
    res.redirect('/');
  });
});

// Attaches a per-request Spotify client (req.spotifyApi) with a valid,
// refreshed-if-needed access token. Never shares one client across users.
function notAuthenticated(req, res) {
  // XHR/fetch calls (all our /api/* routes) can't usefully follow a
  // redirect to Spotify's login page — it's cross-origin and CORS blocks
  // it, so fetch() just throws with no useful info. Send JSON instead so
  // the client can detect "not logged in" and react (e.g. prompt login).
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  return res.redirect('/login');
}

async function auth(req, res, next) {
  if (!req.session.accessToken || !req.session.refreshToken) {
    return notAuthenticated(req, res);
  }

  const client = createSpotifyClient();
  const isExpired = !req.session.expiresAt || Date.now() > req.session.expiresAt - 60_000;

  if (isExpired) {
    try {
      client.setRefreshToken(req.session.refreshToken);
      const refreshed = await client.refreshAccessToken();

      req.session.accessToken = refreshed.body.access_token;
      req.session.expiresAt = Date.now() + refreshed.body.expires_in * 1000;
      if (refreshed.body.refresh_token) {
        req.session.refreshToken = refreshed.body.refresh_token;
      }
    } catch (err) {
      console.error('Token refresh failed:', err.message);
      req.session.destroy(() => {});
      return notAuthenticated(req, res);
    }
  }

  client.setAccessToken(req.session.accessToken);
  req.spotifyApi = client;
  next();
}

// Returns the Spotify user ID for req, fetching + caching it in the
// session if an older session (from before this field existed) doesn't
// have it yet.
async function getSpotifyUserId(req) {
  if (!req.session.spotifyUserId) {
    const me = await req.spotifyApi.getMe();
    req.session.spotifyUserId = me.body.id;
  }
  return req.session.spotifyUserId;
}

app.get('/api/me', auth, asyncHandler(async (req, res) => {
  const data = await req.spotifyApi.getMe();
  res.json(data.body);
}));

app.get('/api/top-tracks', auth, asyncHandler(async (req, res) => {
  const timeRange = ALLOWED_TIME_RANGES.includes(req.query.time_range)
    ? req.query.time_range
    : 'short_term';

  console.log('GET /api/top-tracks time_range =', req.query.time_range, '-> using', timeRange);

  const data = await req.spotifyApi.getMyTopTracks({ limit: 50, time_range: timeRange });
  res.json(data.body.items);
}));

app.get('/api/top-artists', auth, asyncHandler(async (req, res) => {
  const timeRange = ALLOWED_TIME_RANGES.includes(req.query.time_range)
    ? req.query.time_range
    : 'short_term';

  const data = await req.spotifyApi.getMyTopArtists({ limit: 50, time_range: timeRange });
  res.json(data.body.items);
}));

app.get('/api/recent', auth, asyncHandler(async (req, res) => {
  const data = await req.spotifyApi.getMyRecentlyPlayedTracks({ limit: 50 });
  res.json(data.body.items);
}));

app.get('/api/token', auth, (req, res) => {
  res.json({ accessToken: req.session.accessToken });
});

app.use(express.json());

app.get('/api/lastfm/status', auth, asyncHandler(async (req, res) => {
  const spotifyUserId = await getSpotifyUserId(req);
  const username = await getLastfmUsername(spotifyUserId);
  res.json({ linked: !!username, username });
}));

app.post('/api/lastfm/link', auth, asyncHandler(async (req, res) => {
  const username = (req.body?.username || '').trim();

  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }

  // Verify the username actually exists on Last.fm before saving it, so a
  // typo surfaces immediately instead of failing later on /api/lastfm/stats.
  await lastfmRequest({ method: 'user.getinfo', user: username });

  const spotifyUserId = await getSpotifyUserId(req);
  await setLastfmUsername(spotifyUserId, username);

  res.json({ linked: true, username });
}));

app.post('/api/lastfm/unlink', auth, asyncHandler(async (req, res) => {
  const spotifyUserId = await getSpotifyUserId(req);
  await deleteLastfmUsername(spotifyUserId);
  res.json({ linked: false });
}));

app.get('/api/lastfm/stats', auth, asyncHandler(async (req, res) => {
  const spotifyUserId = await getSpotifyUserId(req);
  const username = await getLastfmUsername(spotifyUserId);

  if (!username) {
    return res.status(400).json({ error: 'No Last.fm account linked yet' });
  }

  const [userInfoData, topArtistsData] = await Promise.all([
    lastfmRequest({ method: 'user.getinfo', user: username }),
    lastfmRequest({ method: 'user.gettopartists', user: username, period: 'overall', limit: 50 })
  ]);

  const topArtists = topArtistsData.topartists?.artist || [];
  const topArtistsForTags = topArtists.slice(0, 10);

  // Last.fm has no "favorite genre" field for a user directly, so we infer
  // it: pull each top artist's tags (crowd-sourced genre labels) and tally
  // them, weighted by how much that artist was actually played, so one
  // heavily-played artist's tags count for more than a barely-played one.
  const tagWeights = new Map();

  await Promise.all(topArtistsForTags.map(async artist => {
    try {
      const tagData = await lastfmRequest({ method: 'artist.gettoptags', artist: artist.name });
      const tags = (tagData.toptags?.tag || []).slice(0, 5);
      const artistPlaycount = Number(artist.playcount) || 1;

      tags.forEach((tag, i) => {
        const tagWeight = artistPlaycount * (5 - i); // decay for lower-ranked tags
        tagWeights.set(tag.name, (tagWeights.get(tag.name) || 0) + tagWeight);
      });
    } catch (e) {
      console.warn(`Could not fetch tags for artist "${artist.name}":`, e.message);
    }
  }));

  const topGenres = [...tagWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);

  // --- "Fun stats" -------------------------------------------------
  const totalScrobbles = Number(userInfoData.user?.playcount) || 0;

  const registeredUnix = Number(userInfoData.user?.registered?.unixtime) || null;
  const memberSinceYear = registeredUnix ? new Date(registeredUnix * 1000).getFullYear() : null;

  // "Dominance": what share of top-50 plays belong to the single most-played
  // artist. High share = you stick to your favorites; low share = you
  // spread plays across a lot of different artists.
  const totalTopPlays = topArtists.reduce((sum, a) => sum + (Number(a.playcount) || 0), 0);
  const topArtistPlaycount = Number(topArtists[0]?.playcount) || 0;
  const dominancePercent = totalTopPlays > 0 ? Math.round((topArtistPlaycount / totalTopPlays) * 100) : null;

  let listeningStyle = null;
  if (dominancePercent !== null) {
    if (dominancePercent >= 25) listeningStyle = 'Loyalist';
    else if (dominancePercent <= 8) listeningStyle = 'Explorer';
    else listeningStyle = 'Balanced';
  }

  res.json({
    favoriteGenre: topGenres[0] || null,
    topGenres,
    funStats: {
      totalScrobbles,
      memberSinceYear,
      topArtistName: topArtists[0]?.name || null,
      dominancePercent,
      listeningStyle,
      genresExplored: tagWeights.size
    }
  });
}));

// Estimates total minutes listened for a period by summing (track duration
// x play count) across as many of the user's top tracks as Last.fm will
// return (max 1000/page). Still an estimate — Last.fm has no exact "total
// listening time" field — but pulling up to 1000 tracks instead of just
// the top 10 captures the vast majority of real listening for most users.
async function estimateMinutesForPeriod(username, period) {
  let totalMinutes = 0;
  let page = 1;
  const perPage = 1000; // Last.fm's max page size

  while (true) {
    const data = await lastfmRequest({
      method: 'user.gettoptracks',
      user: username,
      period,
      limit: perPage,
      page
    });

    const tracks = data.toptracks?.track || [];

    for (const track of tracks) {
      const playcount = Number(track.playcount) || 0;
      const durationSeconds = Number(track.duration) || 0;
      if (durationSeconds > 0) {
        totalMinutes += (durationSeconds * playcount) / 60;
      }
    }

    const totalPages = Number(data.toptracks?.['@attr']?.totalPages) || 1;
    if (page >= totalPages || tracks.length === 0) break;
    page += 1;
  }

  return Math.round(totalMinutes * 10) / 10;
}

app.get('/api/lastfm/time-summary', auth, asyncHandler(async (req, res) => {
  const spotifyUserId = await getSpotifyUserId(req);
  const username = await getLastfmUsername(spotifyUserId);

  if (!username) {
    return res.status(400).json({ error: 'No Last.fm account linked yet' });
  }

  const [week, month, year] = await Promise.all([
    estimateMinutesForPeriod(username, '7day'),
    estimateMinutesForPeriod(username, '1month'),
    estimateMinutesForPeriod(username, '12month')
  ]);

  res.json({
    week,
    month,
    year,
    note: 'Estimated from tracks with known duration on Last.fm — not an exact total.'
  });
}));

// Runs `items` through `fn` with at most `limit` in flight at once, so a
// 50-track request doesn't fire 50 simultaneous calls at Last.fm.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// track.getinfo/artist.getinfo only ever return all-time userplaycount —
// Last.fm has no "give me this track's playcount for the last month"
// lookup by name. To get a number that actually matches the Month / 6
// Months / Year tabs, we instead pull the user's *ranked track/artist list
// for that period* (user.gettoptracks/gettopartists both accept a `period`
// param) and match the requested tracks/artists against it. A track that
// doesn't appear in that period's list genuinely wasn't scrobbled during
// that window, so it's reported as 0 minutes rather than "unknown".
function spotifyRangeToLastfmPeriod(range) {
  switch (range) {
    case 'short_term': return '1month';   // Spotify's ~4-week window
    case 'medium_term': return '6month';  // Spotify's ~6-month window
    case 'long_term': return 'overall';   // Spotify's multi-year window — Last.fm has no >12month bucket, so this is the closest fit
    default: return 'overall';
  }
}

// Fetches every track the user scrobbled in `period`, keyed by normalized
// "artist|track" so per-track lookups below are just Map reads instead of
// one Last.fm request per track. Paginated the same way estimateMinutesForPeriod
// is, since gettoptracks caps at 1000 results per page.
async function getLastfmTrackPlaysForPeriod(username, period) {
  const map = new Map();
  let page = 1;
  const perPage = 1000;

  while (true) {
    const data = await lastfmRequest({
      method: 'user.gettoptracks',
      user: username,
      period,
      limit: perPage,
      page
    });

    const tracks = data.toptracks?.track || [];
    for (const t of tracks) {
      const key = `${normalizeArtistName(t.artist?.name)}|${normalizeTrackName(t.name)}`;
      map.set(key, {
        playcount: Number(t.playcount) || 0,
        durationSeconds: Number(t.duration) || 0
      });
    }

    const totalPages = Number(data.toptracks?.['@attr']?.totalPages) || 1;
    if (page >= totalPages || tracks.length === 0) break;
    page += 1;
  }

  return map;
}

async function getLastfmArtistPlaysForPeriod(username, period) {
  const map = new Map();
  let page = 1;
  const perPage = 1000;

  while (true) {
    const data = await lastfmRequest({
      method: 'user.gettopartists',
      user: username,
      period,
      limit: perPage,
      page
    });

    const artists = data.topartists?.artist || [];
    for (const a of artists) {
      map.set(normalizeArtistName(a.name), Number(a.playcount) || 0);
    }

    const totalPages = Number(data.topartists?.['@attr']?.totalPages) || 1;
    if (page >= totalPages || artists.length === 0) break;
    page += 1;
  }

  return map;
}

// Given a list of { name, artist } seed tracks (e.g. the user's Spotify
// Top Tracks) and a Spotify time_range, looks up this user's Last.fm play
// count for each *within that same period* and estimates minutes listened
// (duration x playcount). Returns null only when the track can't be
// matched at all (e.g. missing name/artist); a real period-mismatch is 0.
app.post('/api/lastfm/track-times', auth, asyncHandler(async (req, res) => {
  const spotifyUserId = await getSpotifyUserId(req);
  const username = await getLastfmUsername(spotifyUserId);

  if (!username) {
    return res.status(400).json({ error: 'No Last.fm account linked yet' });
  }

  const tracks = Array.isArray(req.body?.tracks) ? req.body.tracks : [];
  const range = ALLOWED_TIME_RANGES.includes(req.body?.range) ? req.body.range : 'long_term';
  const period = spotifyRangeToLastfmPeriod(range);

  const playsMap = await getLastfmTrackPlaysForPeriod(username, period);

  const times = await mapWithConcurrency(tracks, 5, async t => {
    const name = (t?.name || '').trim();
    const artist = (t?.artist || '').trim();
    if (!name || !artist) return null;

    let match = playsMap.get(`${normalizeArtistName(artist)}|${normalizeTrackName(name)}`);

    // Direct match failed — same idea as the artist lookup above: ask
    // Last.fm's autocorrect for the canonical artist/track spelling it
    // actually stores scrobbles under, and retry with that.
    if (!match) {
      try {
        const corrected = await lastfmRequest({ method: 'track.getinfo', track: name, artist, autocorrect: 1 });
        const info = corrected.track;
        const canonicalArtist = info?.artist?.name;
        const canonicalTrack = info?.name;
        if (canonicalArtist && canonicalTrack) {
          match = playsMap.get(`${normalizeArtistName(canonicalArtist)}|${normalizeTrackName(canonicalTrack)}`);
        }
      } catch (e) {
        return null; // track not recognized by Last.fm at all
      }
    }

    if (!match) return 0; // not scrobbled during this period

    const { playcount, durationSeconds } = match;
    if (playcount <= 0 || durationSeconds <= 0) return 0;

    return Math.round((durationSeconds * playcount / 60) * 10) / 10;
  });

  res.json({ times });
}));

// Estimates total minutes listened to an artist *within a given period*.
// Last.fm has no single "duration" for an artist, so this multiplies the
// artist's period-specific play count (from user.gettopartists — see
// getLastfmArtistPlaysForPeriod above, same period-matching approach as
// track-times) by the artist's average track length on Spotify (from
// their Top Tracks) as an approximation. Less precise than the per-track
// times, but the best available without summing every individual track
// they've scrobbled by that artist.
app.post('/api/lastfm/artist-times', auth, asyncHandler(async (req, res) => {
  const spotifyUserId = await getSpotifyUserId(req);
  const username = await getLastfmUsername(spotifyUserId);

  if (!username) {
    return res.status(400).json({ error: 'No Last.fm account linked yet' });
  }

  const artists = Array.isArray(req.body?.artists) ? req.body.artists : [];
  const range = ALLOWED_TIME_RANGES.includes(req.body?.range) ? req.body.range : 'long_term';
  const period = spotifyRangeToLastfmPeriod(range);

  const playsMap = await getLastfmArtistPlaysForPeriod(username, period);

  const times = await mapWithConcurrency(artists, 5, async a => {
    const id = (a?.id || '').trim();
    const name = (a?.name || '').trim();
    if (!name) return null;

    let playcount = playsMap.get(normalizeArtistName(name)) || 0;

    // Direct match failed — Last.fm may have this artist's scrobbles
    // filed under a slightly different spelling than Spotify uses (word
    // order, "feat." credits, regional aliases, etc). Ask Last.fm's own
    // autocorrect for the canonical name it actually stores plays under,
    // and retry the lookup with that instead of giving up.
    if (playcount <= 0) {
      try {
        const corrected = await lastfmRequest({ method: 'artist.getinfo', artist: name, username, autocorrect: 1 });
        const canonicalName = corrected.artist?.name;
        if (canonicalName) {
          playcount = playsMap.get(normalizeArtistName(canonicalName)) || 0;
        }
      } catch (e) {
        return null; // artist not recognized by Last.fm at all
      }
    }

    if (playcount <= 0) return 0; // not scrobbled during this period

    try {
      const topTracksData = id ? await req.spotifyApi.getArtistTopTracks(id, 'US').catch(() => null) : null;
      const spotifyTracks = topTracksData?.body?.tracks || [];
      if (!spotifyTracks.length) return null;

      const avgDurationMs = spotifyTracks.reduce((sum, t) => sum + (t.duration_ms || 0), 0) / spotifyTracks.length;
      if (avgDurationMs <= 0) return null;

      return Math.round(((avgDurationMs / 1000) * playcount / 60) * 10) / 10;
    } catch (e) {
      return null;
    }
  });

  res.json({ times, estimated: true });
}));

// Strips things like "(Remastered 2011)", "- Live", "- Radio Edit" so we can
// compare two tracks by their "real" title and catch re-releases/duplicates
// that have different Spotify IDs but are really the same song.
function normalizeTrackName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/-\s*(remaster(ed)?|live|radio edit|mono|stereo|single|deluxe|version|mix).*$/i, '')
    .trim();
}

// Spotify and Last.fm don't always spell an artist's name identically
// (accents, "&" vs "and", stray whitespace, curly vs straight quotes), so
// matching artist names across the two APIs needs to fold those away or
// most artists silently fail to match and report 0 minutes.
function normalizeArtistName(name) {
  return (name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Autocomplete search for the Similar Songs / player tab. Spotify's search
// endpoint matches substrings anywhere, so we ask for a few extra results
// and prefer ones that actually start with what was typed (i.e. "legen"
// surfaces "Legendary" before something with "legen" mid-word).
app.get('/api/search-tracks', auth, asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();

  if (q.length < 2) {
    return res.json([]);
  }

  // Spotify's Feb 2026 changes capped /search's limit at 10 (down from 50);
  // requesting more than that now returns a 400 "Invalid limit" error.
  const data = await req.spotifyApi.searchTracks(q, { limit: 10 });
  const items = data.body.tracks.items;

  const startsWith = t => t.name.toLowerCase().startsWith(q.toLowerCase());
  items.sort((a, b) => Number(startsWith(b)) - Number(startsWith(a)));

  // Collapse re-releases/remasters/radio edits of the same song (by name +
  // primary artist) down to a single dropdown entry.
  const seen = new Set();
  const deduped = [];
  for (const t of items) {
    const key = `${normalizeTrackName(t.name)}::${(t.artists?.[0]?.name || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }

  res.json(deduped.slice(0, 8));
}));

// Finds tracks "similar" to a given seed track.
//
// Note: Spotify deprecated the Recommendations, Related Artists, and
// Audio Features endpoints for all apps created after Nov 27 2024 (no
// official replacement since), so a real audio-similarity match — the kind
// something like Chosic's playlist generator does with its own audio
// analysis — isn't something we can build against the Spotify API alone.
//
// As a practical stand-in, this pulls from two sources via /search (still
// available): (1) other tracks by the seed artist, and (2) tracks tagged
// with the seed artist's genres, which brings in other artists too instead
// of being limited to a single artist's catalog.
app.get('/api/similar-track', auth, asyncHandler(async (req, res) => {
  const seedId = (req.query.id || '').trim();

  if (!seedId) {
    return res.status(400).json({ error: 'id is required' });
  }

  const seedData = await req.spotifyApi.getTrack(seedId);
  const seedTrack = seedData.body;
  const primaryArtistId = seedTrack.artists?.[0]?.id;
  const primaryArtistName = seedTrack.artists?.[0]?.name;

  if (!primaryArtistName) {
    return res.status(404).json({ error: 'Could not find an artist for that track' });
  }

  // Spotify's Feb 2026 changes capped /search's limit at 10 (down from 50),
  // so one call can only return 10 tracks max — page through a few offsets
  // per query instead to build a bigger pool.
  async function pagedSearch(query) {
    const results = [];
    for (const offset of [0, 10]) {
      const searchData = await req.spotifyApi.searchTracks(query, { limit: 10, offset });
      const items = searchData.body.tracks?.items || [];
      results.push(...items);
      if (items.length < 10) break; // no more pages left
    }
    return results;
  }

  const queries = [`artist:"${primaryArtistName}"`];

  // Get Artist (single) is still available post-Feb-2026, unlike the
  // batch "Get Several Artists" endpoint — use it to pull genre tags so we
  // can widen the pool beyond just the seed artist's own catalog.
  if (primaryArtistId) {
    try {
      const artistData = await req.spotifyApi.getArtist(primaryArtistId);
      const genres = artistData.body.genres || [];
      for (const genre of genres.slice(0, 3)) {
        queries.push(`genre:"${genre}"`);
      }
    } catch (e) {
      console.warn('Could not fetch artist genres, continuing with artist-only search:', e.message);
    }
  }

  const rawResults = [];
  for (const query of queries) {
    rawResults.push(...await pagedSearch(query));
  }

  const seedNameKey = normalizeTrackName(seedTrack.name);
  const seenNames = new Set([seedNameKey]);
  const candidates = [];

  for (const t of rawResults) {
    if (t.id === seedTrack.id) continue;
    const nameKey = normalizeTrackName(t.name);
    if (seenNames.has(nameKey)) continue; // same song under a different release/ID
    seenNames.add(nameKey);
    candidates.push(t);
  }

  if (!candidates.length) {
    return res.status(404).json({ error: 'No similar tracks found' });
  }

  // Shuffle so genre-matched and same-artist tracks are mixed together
  // rather than the same-artist ones always showing up first.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  // Return the whole pool (not just one track) so the client can step
  // through it with the next/previous transport buttons.
  res.json({ candidates: candidates.slice(0, 40) });
}));

// Starts playback of a chosen track on the given Web Playback SDK device.
app.put('/api/play', auth, asyncHandler(async (req, res) => {
  const { uri, device_id } = req.body || {};

  if (!uri || !device_id) {
    return res.status(400).json({ error: 'uri and device_id are required' });
  }

  await req.spotifyApi.play({ device_id, uris: [uri] });
  res.json({ ok: true });
}));

app.post('/api/next', auth, asyncHandler(async (req, res) => {
  const { device_id } = req.body || {};
  await req.spotifyApi.skipToNext(device_id ? { device_id } : undefined);
  res.json({ ok: true });
}));

app.post('/api/previous', auth, asyncHandler(async (req, res) => {
  const { device_id } = req.body || {};
  await req.spotifyApi.skipToPrevious(device_id ? { device_id } : undefined);
  res.json({ ok: true });
}));

// Central error handler — catches anything asyncHandler passed to next(),
// including expired/invalid-token errors from the Spotify API.
app.use((err, req, res, next) => {
  const spotifyMessage = err.body?.error?.message;
  console.error(`Error on ${req.method} ${req.originalUrl}:`, err.body || err.message || err);
  const status = err?.statusCode || err?.status || 500;
  res.status(status).json({ error: spotifyMessage || 'Something went wrong. Please try again.' });
});

initLastfmStore()
  .then(() => {
    app.listen(process.env.PORT || 3000, () => {
      console.log(`Running on port ${process.env.PORT || 3000} (Last.fm storage: ${usingPostgres ? 'Postgres' : 'local JSON file'})`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize Last.fm storage:', err);
    process.exit(1);
  });