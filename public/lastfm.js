(function () {
  const section = document.getElementById('lastfm-section');
  const connectBox = document.getElementById('lastfm-connect');
  const connectForm = document.getElementById('lastfm-connect-form');
  const usernameInput = document.getElementById('lastfm-username-input');
  const connectError = document.getElementById('lastfm-connect-error');
  const statsBox = document.getElementById('lastfm-stats');
  const genreChips = document.getElementById('lastfm-genre-chips');
  const timeWeekEl = document.getElementById('lastfm-time-week');
  const timeMonthEl = document.getElementById('lastfm-time-month');
  const timeYearEl = document.getElementById('lastfm-time-year');
  const funList = document.getElementById('lastfm-fun-list');
  const unlinkBtn = document.getElementById('lastfm-unlink');
  const skeleton = document.getElementById('lastfm-skeleton');
  const statusEl = document.getElementById('lastfm-status');

  if (!section) return; // Profile panel not present

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('lastfm__status--error', !!isError);
  }

  function showConnect() {
    connectBox.hidden = false;
    statsBox.hidden = true;
    skeleton.hidden = true;
  }

  function showSkeleton() {
    connectBox.hidden = true;
    statsBox.hidden = true;
    skeleton.hidden = false;
  }

  function showStats() {
    connectBox.hidden = true;
    statsBox.hidden = false;
    skeleton.hidden = true;
  }

  // "around 3 hours 12 minutes" / "around 45 minutes"
  function formatHoursMinutes(totalMinutes) {
    const minutes = Math.round(totalMinutes || 0);
    if (minutes < 60) {
      return `around ${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const hoursText = `${hours} hour${hours === 1 ? '' : 's'}`;
    const minsText = mins ? ` ${mins} minute${mins === 1 ? '' : 's'}` : '';
    return `around ${hoursText}${minsText}`;
  }

  function renderFunStats(funStats) {
    funList.innerHTML = '';
    const items = [];

    if (funStats.totalScrobbles) {
      items.push(`🎧 ${funStats.totalScrobbles.toLocaleString()} scrobbles logged all-time`);
    }
    if (funStats.memberSinceYear) {
      items.push(`📅 Scrobbling since ${funStats.memberSinceYear}`);
    }
    if (funStats.topArtistName) {
      items.push(`🏆 Most played artist: ${funStats.topArtistName}`);
    }
    if (funStats.listeningStyle) {
      const styleBlurb = {
        Loyalist: 'you stick close to your favorites',
        Explorer: 'you spread plays across lots of different artists',
        Balanced: 'a healthy mix of favorites and new discoveries'
      }[funStats.listeningStyle] || '';
      items.push(`🧭 Listening style: ${funStats.listeningStyle}${styleBlurb ? ` — ${styleBlurb}` : ''}`);
    }
    if (funStats.genresExplored) {
      items.push(`🎨 ${funStats.genresExplored} different genre tags across your top artists`);
    }

    if (!items.length) {
      const li = document.createElement('li');
      li.textContent = 'Not enough data yet — keep listening!';
      funList.appendChild(li);
      return;
    }

    items.forEach(text => {
      const li = document.createElement('li');
      li.textContent = text;
      funList.appendChild(li);
    });
  }

  async function loadGenresAndFunStats() {
    const res = await fetch('/api/lastfm/stats');
    if (res.status === 400) return null;
    if (!res.ok) throw new Error('Request failed');
    return res.json();
  }

  async function loadTimeSummary() {
    const res = await fetch('/api/lastfm/time-summary');
    if (res.status === 400) return null;
    if (!res.ok) throw new Error('Request failed');
    return res.json();
  }

  async function loadAll() {
    showSkeleton();
    setStatus('');

    try {
      const [statsData, timeData] = await Promise.all([
        loadGenresAndFunStats(),
        loadTimeSummary()
      ]);

      if (!statsData || !timeData) {
        showConnect();
        return;
      }

      genreChips.innerHTML = '';
      if (statsData.topGenres.length) {
        statsData.topGenres.forEach((genre, i) => {
          const chip = document.createElement('span');
          chip.className = 'lastfm__chip' + (i === 0 ? ' lastfm__chip--primary' : '');
          chip.textContent = genre;
          genreChips.appendChild(chip);
        });
      } else {
        const chip = document.createElement('span');
        chip.className = 'lastfm__chip';
        chip.textContent = 'Not enough data yet';
        genreChips.appendChild(chip);
      }

      timeWeekEl.textContent = formatHoursMinutes(timeData.week);
      timeMonthEl.textContent = formatHoursMinutes(timeData.month);
      timeYearEl.textContent = formatHoursMinutes(timeData.year);

      renderFunStats(statsData.funStats || {});

      showStats();
      setStatus(timeData.note || '');
    } catch (err) {
      console.error(err);
      showConnect();
      setStatus("Couldn't load Last.fm stats — try again in a moment.", true);
    }
  }

  async function init() {
    try {
      const res = await fetch('/api/lastfm/status');
      if (!res.ok) throw new Error('Request failed');

      const data = await res.json();
      section.hidden = false;

      // In normal use this panel only becomes reachable once the top-level
      // connect gate in index.html has already linked an account, so this
      // should always be true — the connect box below is just a defensive
      // fallback in case this script ever runs before that.
      if (data.linked) {
        loadAll();
      } else {
        showConnect();
      }
    } catch (err) {
      console.error(err);
      section.hidden = true;
    }
  }

  connectForm.addEventListener('submit', async e => {
    e.preventDefault();
    const username = usernameInput.value.trim();
    if (!username) return;

    connectError.hidden = true;
    const submitBtn = connectForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    try {
      const res = await fetch('/api/lastfm/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username })
      });

      const data = await res.json();

      if (!res.ok) {
        connectError.textContent = data.error || "Couldn't find that Last.fm username.";
        connectError.hidden = false;
        return;
      }

      usernameInput.value = '';
      window.dispatchEvent(new CustomEvent('lastfm-status-changed'));
      loadAll();
    } catch (err) {
      console.error(err);
      connectError.textContent = 'Something went wrong — try again.';
      connectError.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  unlinkBtn.addEventListener('click', async () => {
    unlinkBtn.disabled = true;
    try {
      await fetch('/api/lastfm/unlink', { method: 'POST' });
      // Disconnecting here now un-links the whole app (Last.fm is the only
      // account there is), so send the person back to the top-level
      // connect gate rather than just hiding this one panel.
      window.location.reload();
    } catch (err) {
      console.error(err);
      unlinkBtn.disabled = false;
    }
  });

  init();
})();