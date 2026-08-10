require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const REQUIRED_ENV = ['SESSION_SECRET', 'LASTFM_API_KEY'];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length) {
  console.error(`Missing required environment variable(s): ${missingEnv.join(', ')}`);
  process.exit(1);
}

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_BASE_URL = 'https://ws.audioscrobbler.com/2.0/';

// Last.fm stopped serving real cover art / avatars for most requests around
// 2019 and instead returns either an empty string or this one grey "no
// image available" placeholder for basically everything. We filter it out
// so the frontend falls back to its own empty-thumbnail styling instead of
// showing a broken-looking grey square everywhere.
const LASTFM_PLACEHOLDER_HASH = '2a96cbd8b46e442fc41c2b86b821562f';

// Last.fm image arrays come back ordered small -> extralarge (ascending).
// The rest of this app (originally written against Spotify's API) expects
// largest -> smallest, so we reverse once here and let every caller keep
// using images[0] (biggest) / images[length-1] (smallest) like before.
function normalizeImages(rawImages) {
  if (!Array.isArray(rawImages)) return [];
  return rawImages
    .map(img => img && img['#text'])
    .filter(url => url && !url.includes(LASTFM_PLACEHOLDER_HASH))
    .reverse()
    .map(url => ({ url }));
}

// --- Optional Spotify-backed cover art ------------------------------------
// Spotify credentials are OPTIONAL and used only for app-level
// (client-credentials) auth to look up cover art. No user ever logs into
// Spotify and no per-user Spotify data is read — this is purely "does this
// track/artist have a picture", the same as an anonymous visitor to
// open.spotify.com would get. All real stats still come from Last.fm.
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const spotifyArtEnabled = !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET);

if (!spotifyArtEnabled) {
  console.warn('SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET not set — cover art will stay blank (Last.fm no longer serves real artwork).');
}

let spotifyToken = null;
let spotifyTokenExpiresAt = 0;

// Client-credentials grant: authenticates as the *app*, not a user.
async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiresAt - 30_000) {
    return spotifyToken;
  }

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')
    },
    body: 'grant_type=client_credentials'
  });

  if (!res.ok) {
    throw new Error(`Spotify token request failed (${res.status})`);
  }

  const data = await res.json();
  spotifyToken = data.access_token;
  spotifyTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return spotifyToken;
}

// Small in-memory cache so the same track/artist isn't re-searched on every
// page load — cover art rarely changes, and this keeps repeat visits fast
// and well clear of Spotify's rate limits. Cleared on restart; that's fine,
// it just rebuilds itself on demand.
const ART_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const artCache = new Map(); // key -> { images, expiresAt }

function getCachedArt(key) {
  const entry = artCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    artCache.delete(key);
    return undefined;
  }
  return entry.images;
}

function setCachedArt(key, images) {
  artCache.set(key, { images, expiresAt: Date.now() + ART_CACHE_TTL_MS });
  if (artCache.size > 5000) {
    artCache.delete(artCache.keys().next().value); // crude cap so this can't grow forever
  }
}

async function findSpotifyTrackArt(name, artist) {
  const key = `track:${name.toLowerCase()}|${artist.toLowerCase()}`;
  const cached = getCachedArt(key);
  if (cached !== undefined) return cached;

  let images = [];
  try {
    const token = await getSpotifyToken();
    const q = `track:${name} artist:${artist}`;
    const url = `https://api.spotify.com/v1/search?type=track&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const data = await res.json();
      const track = data.tracks?.items?.[0];
      // Spotify's image arrays are already largest -> smallest, unlike
      // Last.fm's, so no reordering needed here.
      images = (track?.album?.images || []).map(img => ({ url: img.url }));
    }
  } catch (e) {
    console.warn(`Spotify art lookup failed for track "${name}" by "${artist}":`, e.message);
  }

  setCachedArt(key, images);
  return images;
}

async function findSpotifyArtistArt(name) {
  const key = `artist:${name.toLowerCase()}`;
  const cached = getCachedArt(key);
  if (cached !== undefined) return cached;

  let images = [];
  try {
    const token = await getSpotifyToken();
    const url = `https://api.spotify.com/v1/search?type=artist&limit=1&q=${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const data = await res.json();
      const artist = data.artists?.items?.[0];
      images = (artist?.images || []).map(img => ({ url: img.url }));
    }
  } catch (e) {
    console.warn(`Spotify art lookup failed for artist "${name}":`, e.message);
  }

  setCachedArt(key, images);
  return images;
}

// Runs `items` through `fn` with at most `limit` in flight at once, so a
// 50-row page doesn't fire 50 simultaneous requests at Spotify.
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

// Thin wrapper around Last.fm's REST API (method + params -> parsed JSON).
// Last.fm returns HTTP 200 with an `error` field for most failures (bad
// username, unknown method, etc.), so we check that explicitly rather than
// relying on response.ok. Error code 6 = "user not found" — surfaced as a
// 400 so the client can show it inline; anything else is treated as an
// upstream failure (502).
async function lastfmRequest(params) {
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
    err.statusCode = data.error === 6 ? 400 : 502;
    throw err;
  }

  return data;
}

const app = express();

// Render (and most PaaS hosts) sit behind a reverse proxy that terminates
// HTTPS for you — without this, Express thinks the connection isn't secure
// and the `secure: true` cookie below never gets set.
app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    // There's no OAuth token to refresh anymore, so this is the only thing
    // that expires: after 7 days (or a server restart, since this uses the
    // default in-memory session store) a person just retypes their Last.fm
    // username — no password, so the friction is low. If you want that to
    // survive restarts/deploys, swap in a persistent session store
    // (e.g. connect-pg-simple) — the rest of the app doesn't care how the
    // session is stored.
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production'
  }
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Wraps async route handlers so rejected promises reach Express's error
// handler instead of crashing the process.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const ALLOWED_TIME_RANGES = ['short_term', 'medium_term', 'long_term'];

// Maps the frontend's Spotify-flavored range names onto Last.fm's `period`
// values. "Year" now maps to a genuine rolling 12 months (Last.fm has no
// >12month bucket short of `overall`, which would mean "all time" instead).
function timeRangeToPeriod(range) {
  switch (range) {
    case 'medium_term': return '6month';
    case 'long_term': return '12month';
    case 'short_term':
    default: return '1month';
  }
}

function notLinked(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'No Last.fm account linked yet' });
  }
  return res.redirect('/');
}

function requireLink(req, res, next) {
  if (!req.session.lastfmUsername) return notLinked(req, res);
  next();
}

// --- linking (this is the entire "auth" system now) ---------------------
app.get('/api/lastfm/status', (req, res) => {
  res.json({ linked: !!req.session.lastfmUsername, username: req.session.lastfmUsername || null });
});

app.post('/api/lastfm/link', asyncHandler(async (req, res) => {
  const username = (req.body?.username || '').trim();
  if (!username) {
    return res.status(400).json({ error: 'username is required' });
  }

  // Verify the username actually exists on Last.fm before saving it, so a
  // typo surfaces immediately instead of failing later on every other
  // endpoint. Also grab Last.fm's canonical casing for the name.
  const info = await lastfmRequest({ method: 'user.getinfo', user: username });
  req.session.lastfmUsername = info.user?.name || username;

  res.json({ linked: true, username: req.session.lastfmUsername });
}));

app.post('/api/lastfm/unlink', (req, res) => {
  delete req.session.lastfmUsername;
  res.json({ linked: false });
});

// --- profile -------------------------------------------------------------
app.get('/api/me', requireLink, asyncHandler(async (req, res) => {
  const data = await lastfmRequest({ method: 'user.getinfo', user: req.session.lastfmUsername });
  const u = data.user || {};

  res.json({
    username: u.name,
    display_name: u.realname || u.name,
    url: u.url,
    playcount: Number(u.playcount) || 0,
    registeredYear: u.registered?.unixtime
      ? new Date(Number(u.registered.unixtime) * 1000).getFullYear()
      : null,
    images: normalizeImages(u.image)
  });
}));

// --- top tracks / top artists / recently played ---------------------------
// user.gettoptracks already returns playcount + duration *for the
// requested period*, so — unlike the old Spotify+Last.fm-matching version
// of this endpoint — no separate lookup or fuzzy name-matching is needed to
// attach an accurate "time played" estimate; it's native to this one call.
app.get('/api/top-tracks', requireLink, asyncHandler(async (req, res) => {
  const range = ALLOWED_TIME_RANGES.includes(req.query.time_range) ? req.query.time_range : 'short_term';
  const period = timeRangeToPeriod(range);

  const data = await lastfmRequest({
    method: 'user.gettoptracks',
    user: req.session.lastfmUsername,
    period,
    limit: 50
  });

  const tracks = data.toptracks?.track || [];

  const mapped = tracks.map(t => {
    const playcount = Number(t.playcount) || 0;
    const durationSeconds = Number(t.duration) || 0;
    return {
      name: t.name,
      artists: [{ name: t.artist?.name || 'Unknown artist' }],
      album: { images: normalizeImages(t.image) },
      playcount,
      // null (not 0) when Last.fm doesn't know the track's duration, so the
      // frontend can show "—" instead of a misleading "0m".
      estimatedMinutes: durationSeconds > 0
        ? Math.round((durationSeconds * playcount / 60) * 10) / 10
        : null
    };
  });

  // Last.fm's own images are filtered to empty by normalizeImages() above
  // (see the placeholder note near the top of this file), so fill in real
  // cover art from Spotify when it's configured.
  if (spotifyArtEnabled) {
    await mapWithConcurrency(mapped, 5, async track => {
      if (track.album.images.length) return;
      track.album.images = await findSpotifyTrackArt(track.name, track.artists[0]?.name || '');
    });
  }

  res.json(mapped);
}));

// Last.fm has no per-artist duration, so an artist's listening time is
// estimated by summing (duration x playcount) across every track by that
// artist in the user's full top-tracks list for the period (see
// getArtistMinutesForPeriod below) — more accurate than the old
// average-track-length guess the Spotify-backed version used.
app.get('/api/top-artists', requireLink, asyncHandler(async (req, res) => {
  const range = ALLOWED_TIME_RANGES.includes(req.query.time_range) ? req.query.time_range : 'short_term';
  const period = timeRangeToPeriod(range);
  const username = req.session.lastfmUsername;

  const [artistData, minutesByArtist] = await Promise.all([
    lastfmRequest({ method: 'user.gettopartists', user: username, period, limit: 50 }),
    getArtistMinutesForPeriod(username, period)
  ]);

  const artists = artistData.topartists?.artist || [];

  const mapped = artists.map(a => ({
    name: a.name,
    images: normalizeImages(a.image),
    playcount: Number(a.playcount) || 0,
    estimatedMinutes: minutesByArtist.get((a.name || '').toLowerCase()) ?? null
  }));

  if (spotifyArtEnabled) {
    await mapWithConcurrency(mapped, 5, async artist => {
      if (artist.images.length) return;
      artist.images = await findSpotifyArtistArt(artist.name);
    });
  }

  res.json(mapped);
}));

app.get('/api/recent', requireLink, asyncHandler(async (req, res) => {
  const data = await lastfmRequest({
    method: 'user.getrecenttracks',
    user: req.session.lastfmUsername,
    limit: 50
  });

  const tracks = data.recenttracks?.track || [];

  const mapped = tracks.map(t => ({
    nowPlaying: t['@attr']?.nowplaying === 'true',
    track: {
      name: t.name,
      artists: [{ name: t.artist?.['#text'] || 'Unknown artist' }],
      album: { images: normalizeImages(t.image) }
    }
  }));

  if (spotifyArtEnabled) {
    await mapWithConcurrency(mapped, 5, async item => {
      if (item.track.album.images.length) return;
      item.track.album.images = await findSpotifyTrackArt(item.track.name, item.track.artists[0]?.name || '');
    });
  }

  res.json(mapped);
}));

// --- Listening Insights panel: genres + fun stats -------------------------
app.get('/api/lastfm/stats', requireLink, asyncHandler(async (req, res) => {
  const username = req.session.lastfmUsername;

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

// Fetches every track the user scrobbled in `period` (paginated — Last.fm
// caps user.gettoptracks at 1000 results per page). Shared by the total
// minutes-listened estimate and the per-artist minutes estimate below, so
// each only has to page through Last.fm once per request.
async function fetchAllTopTracksForPeriod(username, period) {
  const all = [];
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
    all.push(...tracks);

    const totalPages = Number(data.toptracks?.['@attr']?.totalPages) || 1;
    if (page >= totalPages || tracks.length === 0) break;
    page += 1;
  }

  return all;
}

// Estimates total minutes listened for a period by summing (track duration
// x play count) across as many of the user's top tracks as Last.fm will
// return. Still an estimate — Last.fm has no exact "total listening time"
// field — but pulling up to 1000 tracks instead of just the top 10 captures
// the vast majority of real listening for most users.
async function estimateMinutesForPeriod(username, period) {
  const tracks = await fetchAllTopTracksForPeriod(username, period);
  let totalMinutes = 0;

  for (const track of tracks) {
    const playcount = Number(track.playcount) || 0;
    const durationSeconds = Number(track.duration) || 0;
    if (durationSeconds > 0) {
      totalMinutes += (durationSeconds * playcount) / 60;
    }
  }

  return Math.round(totalMinutes * 10) / 10;
}

// Same idea as estimateMinutesForPeriod, but bucketed by artist instead of
// summed into one grand total — used to attach a "time played" estimate to
// each row on the Top Artists tab.
async function getArtistMinutesForPeriod(username, period) {
  const tracks = await fetchAllTopTracksForPeriod(username, period);
  const minutes = new Map();

  for (const t of tracks) {
    const playcount = Number(t.playcount) || 0;
    const durationSeconds = Number(t.duration) || 0;
    const key = (t.artist?.name || '').toLowerCase();
    if (!key || durationSeconds <= 0 || playcount <= 0) continue;
    minutes.set(key, (minutes.get(key) || 0) + (durationSeconds * playcount) / 60);
  }

  for (const [key, value] of minutes) {
    minutes.set(key, Math.round(value * 10) / 10);
  }

  return minutes;
}

app.get('/api/lastfm/time-summary', requireLink, asyncHandler(async (req, res) => {
  const username = req.session.lastfmUsername;

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

// Central error handler — catches anything asyncHandler passed to next().
app.use((err, req, res, next) => {
  console.error(`Error on ${req.method} ${req.originalUrl}:`, err.message || err);
  const status = err?.statusCode || 500;
  res.status(status).json({ error: err.message || 'Something went wrong. Please try again.' });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Running on port ${process.env.PORT || 3000}`);
});