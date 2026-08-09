// --- DOM refs ---------------------------------------------------------
const songInput = document.getElementById('song-name');
const resultsEl = document.getElementById('song-results');
const selectedCover = document.getElementById('selected-cover');
const selectedTitle = document.getElementById('selected-title');
const selectedArtist = document.getElementById('selected-artist');
const findBtn = document.getElementById('find-btn');
const playerPanel = document.getElementById('player-panel');
const playerStatus = document.getElementById('player-status');

// --- state --------------------------------------------------------------
let player;
let deviceId;
let searchTimeout;
let selectedTrackUri = null;
let seedTrackId = null;     // the track picked from the dropdown, used as the /api/similar-track seed
let similarTracks = [];     // pool of candidates returned for the current seed
let similarIndex = -1;      // which one in the pool is currently showing

// --- autocomplete search --------------------------------------------------
songInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(searchSongs, 250);
});

// close the results dropdown when clicking outside the search box
document.addEventListener('click', (e) => {
  if (!e.target.closest('.song-search')) {
    resultsEl.innerHTML = '';
  }
});

async function searchSongs() {
  const q = songInput.value.trim();

  if (q.length < 2) {
    resultsEl.innerHTML = '';
    return;
  }

  let tracks = [];
  try {
    const res = await fetch(`/api/search-tracks?q=${encodeURIComponent(q)}`);

    if (res.status === 401) {
      renderMessage('Log in to search for songs.');
      return;
    }
    if (!res.ok) {
      console.error('Song search failed', res.status, await res.text().catch(() => ''));
      renderMessage('Something went wrong searching songs.');
      return;
    }

    tracks = await res.json();
  } catch (e) {
    console.error('Song search request failed', e);
    renderMessage('Something went wrong searching songs.');
    return;
  }

  renderResults(tracks);
}

function renderMessage(text) {
  resultsEl.innerHTML = '';
  resultsEl.hidden = false;
  const msg = document.createElement('div');
  msg.className = 'song-results__message';
  msg.textContent = text;
  resultsEl.appendChild(msg);
}

function renderResults(tracks) {
  resultsEl.innerHTML = '';

  if (!tracks || !tracks.length) {
    resultsEl.hidden = true;
    return;
  }
  resultsEl.hidden = false;

  tracks.forEach(track => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'song-result';

    const coverUrl = track.album?.images?.length
      ? track.album.images[track.album.images.length - 1].url
      : null;

    if (coverUrl) {
      const img = document.createElement('img');
      img.src = coverUrl;
      img.alt = '';
      img.className = 'song-result__cover';
      item.appendChild(img);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'song-result__cover song-result__cover--empty';
      item.appendChild(placeholder);
    }

    const text = document.createElement('span');
    text.className = 'song-result__text';
    const name = document.createElement('span');
    name.className = 'song-result__name';
    name.textContent = track.name;
    const artist = document.createElement('span');
    artist.className = 'song-result__artist';
    artist.textContent = (track.artists || []).map(a => a.name).join(', ');
    text.appendChild(name);
    text.appendChild(artist);
    item.appendChild(text);

    item.addEventListener('click', () => selectSong(track));
    resultsEl.appendChild(item);
  });
}

// --- selection ------------------------------------------------------------
// Picking a result from the dropdown only stages it as the "seed" track —
// nothing plays and the player panel stays hidden until "Find" is clicked.
function selectSong(track) {
  seedTrackId = track.id;

  const artistNames = (track.artists || []).map(a => a.name).join(', ');
  songInput.value = `${track.name} - ${artistNames}`;
  resultsEl.innerHTML = '';
  resultsEl.hidden = true;

  findBtn.disabled = false;
}

// Renders a track into the player display (cover/title/artist) and
// remembers its URI so playSelectedTrack() knows what to play.
function renderTrack(track) {
  selectedTrackUri = track.uri;

  const coverUrl = track.album?.images?.length ? track.album.images[0].url : null;
  selectedCover.src = coverUrl || '';
  selectedCover.style.visibility = coverUrl ? 'visible' : 'hidden';

  const artistNames = (track.artists || []).map(a => a.name).join(', ');
  selectedTitle.textContent = track.name;
  selectedArtist.textContent = artistNames;
}

// --- find a similar song ---------------------------------------------------
findBtn.addEventListener('click', findSimilarSong);

async function findSimilarSong() {
  if (!seedTrackId) return;

  findBtn.disabled = true;
  const originalLabel = findBtn.textContent;
  findBtn.textContent = 'Finding…';

  try {
    const res = await fetch(`/api/similar-track?id=${encodeURIComponent(seedTrackId)}`);

    if (res.status === 401) {
      playerPanel.hidden = false;
      selectedTitle.textContent = 'Log in to find similar songs.';
      selectedArtist.textContent = '';
      return;
    }
    if (!res.ok) {
      console.error('Similar track lookup failed', res.status, await res.text().catch(() => ''));
      playerPanel.hidden = false;
      selectedTitle.textContent = 'Could not find a similar song.';
      selectedArtist.textContent = '';
      return;
    }

    const data = await res.json();
    similarTracks = data.candidates || [];

    if (!similarTracks.length) {
      playerPanel.hidden = false;
      selectedTitle.textContent = 'Could not find a similar song.';
      selectedArtist.textContent = '';
      return;
    }

    similarIndex = Math.floor(Math.random() * similarTracks.length);

    playerPanel.hidden = false;
    renderTrack(similarTracks[similarIndex]);
    await playSelectedTrack();
  } catch (e) {
    console.error('Find similar song failed', e);
    playerPanel.hidden = false;
    selectedTitle.textContent = 'Could not find a similar song.';
    selectedArtist.textContent = '';
  } finally {
    findBtn.textContent = originalLabel;
    findBtn.disabled = false;
  }
}

async function playSelectedTrack() {
  if (!selectedTrackUri) return;

  if (!deviceId) {
    // SDK hasn't reported a ready device yet (or there's no active
    // Premium session) — nothing we can do but tell the user why.
    setStatus('Waiting for the Spotify player to connect… try again in a moment.', true);
    console.warn('No Spotify Connect device ready yet');
    return;
  }

  try {
    const res = await fetch('/api/play', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: selectedTrackUri, device_id: deviceId })
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error('Playback failed', res.status, body);
      setStatus(body.error || `Playback failed (${res.status}).`, true);
      return;
    }

    setStatus('');
  } catch (e) {
    console.error('Failed to start playback', e);
    setStatus('Playback request failed. Check your connection and try again.', true);
  }
}

function setStatus(text, isError = false) {
  if (!playerStatus) return;
  playerStatus.textContent = text;
  playerStatus.classList.toggle('player-status--error', Boolean(isError));
}

// --- Web Playback SDK -------------------------------------------------
window.onSpotifyWebPlaybackSDKReady = async () => {
  const data = await fetch('/api/token').then(r => r.json()).catch(() => null);
  if (!data) {
    setStatus('Could not connect to Spotify — try logging in again.', true);
    return;
  }

  player = new Spotify.Player({
    name: 'StatsFM Clone',
    getOAuthToken: cb => cb(data.accessToken),
    volume: 0.5
  });

  player.addListener('initialization_error', ({ message }) => {
    console.error('Playback SDK init error', message);
    setStatus('Spotify player failed to initialize: ' + message, true);
  });

  player.addListener('authentication_error', ({ message }) => {
    console.error('Playback SDK auth error', message);
    setStatus('Spotify player authentication failed — try logging in again.', true);
  });

  player.addListener('account_error', ({ message }) => {
    console.error('Playback SDK account error', message);
    setStatus('Playback requires a Spotify Premium account.', true);
  });

  player.addListener('ready', ({ device_id }) => {
    deviceId = device_id;
    console.log('Ready', device_id);
    setStatus('');
  });

  player.addListener('not_ready', ({ device_id }) => {
    console.warn('Device went offline', device_id);
    if (deviceId === device_id) deviceId = null;
    setStatus('Spotify player disconnected — try again in a moment.', true);
  });

  player.connect().then(success => {
    if (!success) {
      console.error('player.connect() returned false');
      setStatus('Could not connect the Spotify player. Check the console for details.', true);
    }
  });
};

// --- transport controls -------------------------------------------------
// These step through the pool of similar songs found for the current seed
// (wrapping around at either end) and play whichever one is landed on —
// they don't touch Spotify's real playback queue.
async function next() {
  if (!similarTracks.length) return;
  similarIndex = (similarIndex + 1) % similarTracks.length;
  renderTrack(similarTracks[similarIndex]);
  await playSelectedTrack();
}

async function previous() {
  if (!similarTracks.length) return;
  similarIndex = (similarIndex - 1 + similarTracks.length) % similarTracks.length;
  renderTrack(similarTracks[similarIndex]);
  await playSelectedTrack();
}