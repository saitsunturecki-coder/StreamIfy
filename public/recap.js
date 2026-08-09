// recap.js — the "Monthly Recap" podium tile opens a popup that builds a
// shareable image (top 5 artists, top 5 songs) on a 1080x1920 canvas
// (Instagram Story dimensions), with save + share circle buttons.
(function () {
  const tile = document.getElementById('recap-tile');
  const modal = document.getElementById('recap-modal');
  const canvas = document.getElementById('recap-canvas');
  if (!tile || !modal || !canvas) return; // Home panel not present

  const ctx = canvas.getContext('2d');
  const emptyState = document.getElementById('recap-empty');
  const skeleton = document.getElementById('recap-skeleton');
  const downloadBtn = document.getElementById('recap-download');
  const shareBtn = document.getElementById('recap-share');
  const statusEl = document.getElementById('recap-status');

  const W = canvas.width;
  const H = canvas.height;

  const COLORS = {
    bgTop: '#0a0d0b',
    bgBottom: '#121b15',
    glow: 'rgba(52, 211, 153, 0.18)',
    green: '#34d399',
    text: '#eef2ee',
    textDim: '#8d968e',
    card: '#171b17'
  };

  function setStatus(msg) {
    statusEl.textContent = msg || '';
  }

  function truncate(str, n) {
    if (!str) return '';
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
  }

  function loadImage(url) {
    return new Promise(resolve => {
      if (!url) return resolve(null);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null); // fall back to a placeholder tile
      img.src = url;
    });
  }

  function roundedRectPath(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBackground() {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, COLORS.bgTop);
    grad.addColorStop(1, COLORS.bgBottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    const glow = ctx.createRadialGradient(W * 0.82, H * 0.08, 40, W * 0.82, H * 0.08, 680);
    glow.addColorStop(0, COLORS.glow);
    glow.addColorStop(1, 'rgba(52, 211, 153, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  function drawHeader() {
    const now = new Date();
    const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const month = prevMonthDate.toLocaleString('default', { month: 'long', year: 'numeric' });

    ctx.fillStyle = COLORS.textDim;
    ctx.font = '600 32px Manrope, sans-serif';
    ctx.fillText(month.toUpperCase(), 80, 160);

    ctx.fillStyle = COLORS.text;
    ctx.font = '800 76px Manrope, sans-serif';
    ctx.fillText('My Recap', 78, 250);

    ctx.fillStyle = COLORS.green;
    ctx.fillRect(80, 285, 90, 8);
  }

  function drawSectionLabel(text, y) {
    ctx.fillStyle = COLORS.green;
    ctx.font = '700 36px Manrope, sans-serif';
    ctx.fillText(text, 80, y);
  }

  function drawRow(name, subtitle, img, x, y, size, circular, index) {
    ctx.save();
    if (circular) {
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
      ctx.clip();
    } else {
      roundedRectPath(x, y, size, size, 20);
      ctx.clip();
    }

    if (img) {
      ctx.drawImage(img, x, y, size, size);
    } else {
      ctx.fillStyle = COLORS.card;
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = COLORS.textDim;
      ctx.font = '700 40px Manrope, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText((name || '?').charAt(0).toUpperCase(), x + size / 2, y + size / 2 + 4);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
    ctx.restore();

    ctx.fillStyle = COLORS.green;
    ctx.font = '800 30px Manrope, sans-serif';
    ctx.fillText(String(index + 1).padStart(2, '0'), x + size + 32, y + size / 2 - 6);

    ctx.fillStyle = COLORS.text;
    ctx.font = '700 34px Manrope, sans-serif';
    ctx.fillText(truncate(name, 18), x + size + 32, y + size / 2 + 30);

    if (subtitle) {
      ctx.fillStyle = COLORS.textDim;
      ctx.font = '500 26px Manrope, sans-serif';
      ctx.fillText(truncate(subtitle, 24), x + size + 32, y + size / 2 + 62);
    }
  }

  function drawFooter() {
    ctx.fillStyle = '#4d564f';
    ctx.font = '600 26px Manrope, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Generated with Spotify Stats', W - 80, H - 70);
    ctx.textAlign = 'left';
  }

  async function generate() {
    downloadBtn.disabled = true;
    shareBtn.disabled = true;
    canvas.hidden = true;
    emptyState.hidden = true;
    skeleton.hidden = false;
    setStatus('');

    try {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }

      const [tracks, artists] = await Promise.all([
        fetch('/api/top-tracks').then(r => r.json()),
        fetch('/api/top-artists').then(r => r.json())
      ]);

      const topTracks = tracks.slice(0, 5);
      const topArtists = artists.slice(0, 5);

      const [trackImgs, artistImgs] = await Promise.all([
        Promise.all(topTracks.map(t => loadImage((t.album?.images || [])[0]?.url))),
        Promise.all(topArtists.map(a => loadImage((a.images || [])[0]?.url)))
      ]);

      drawBackground();
      drawHeader();

      const tileSize = 96;
      const rowGap = 132;

      drawSectionLabel('TOP ARTISTS', 400);
      topArtists.forEach((artist, i) => {
        drawRow(artist.name, null, artistImgs[i], 80, 440 + i * rowGap, tileSize, true, i);
      });

      const tracksLabelY = 440 + topArtists.length * rowGap + 70;
      drawSectionLabel('TOP SONGS', tracksLabelY);
      topTracks.forEach((track, i) => {
        const subtitle = (track.artists || []).map(a => a.name).join(', ');
        drawRow(track.name, subtitle, trackImgs[i], 80, tracksLabelY + 40 + i * rowGap, tileSize, false, i);
      });

      drawFooter();

      skeleton.hidden = true;
      canvas.hidden = false;
      downloadBtn.disabled = false;
      shareBtn.disabled = !canShareFiles();
    } catch (err) {
      console.error(err);
      skeleton.hidden = true;
      emptyState.hidden = false;
      emptyState.textContent = "Couldn't build the recap. Try again in a moment.";
    }
  }

  function canvasToFile() {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (!blob) return reject(new Error('Canvas export failed'));
        resolve(new File([blob], 'monthly-recap.png', { type: 'image/png' }));
      }, 'image/png');
    });
  }

  async function download() {
    try {
      const file = await canvasToFile();
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'monthly-recap.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus('Saved to your gallery.');
    } catch (err) {
      console.error(err);
      setStatus("Couldn't save the image — some cover art may be blocking export.");
    }
  }

  function canShareFiles() {
    return !!(navigator.share && navigator.canShare);
  }

  async function shareToInstagram() {
    try {
      const file = await canvasToFile();

      if (canShareFiles() && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'My Monthly Recap',
          text: 'My monthly recap, made with Spotify Stats'
        });
        setStatus('Shared — choose Instagram Stories from the share sheet.');
      } else {
        setStatus("Sharing isn't supported here — saved instead.");
        await download();
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(err);
        setStatus('Sharing failed — try saving instead.');
      }
    }
  }

  function openModal() {
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    generate();
  }

  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  tile.addEventListener('click', openModal);

  modal.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', closeModal);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  downloadBtn.addEventListener('click', download);
  shareBtn.addEventListener('click', shareToInstagram);
})();