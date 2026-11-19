const $ = id => document.getElementById(id);

const role = document.body.dataset.role;
const socket = io();

const sessionKey = `story-wars-${role}`;
const screen = $('screen');
const sounds = role === 'host'
  ? {
      story: new Audio('/audio/story.mp3'),
      double: new Audio('/audio/roo-roo-roo.mp3')
    }
  : null;

if (sounds) {
  sounds.story.preload = 'auto';
  sounds.double.preload = 'auto';
}

let state;
let renderKey;
let animatedRound;
let pending = false;
let copyFeedbackTimer;

let config = {
  theme: '0',
  custom: ''
};

const escapeHTML = value =>
  String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function playSound(audio) {
  audio.pause();
  audio.currentTime = 0;

  return audio.play()
    .then(() => true)
    .catch(() => false);
}

function playNextStoryCue(doublePoints) {
  if (!sounds) return;

  sounds.double.pause();
  sounds.double.currentTime = 0;
  sounds.story.pause();
  sounds.story.currentTime = 0;

  if (!doublePoints) {
    playSound(sounds.story);
    return;
  }

  let storyPlayed = false;
  const playStory = () => {
    if (storyPlayed) return;
    storyPlayed = true;
    playSound(sounds.story);
  };

  sounds.double.addEventListener('ended', playStory, { once: true });
  playSound(sounds.double).then(started => {
    if (!started) {
      sounds.double.removeEventListener('ended', playStory);
      playStory();
    }
  });
}

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall back for browsers that deny clipboard access.
    }
  }

  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.left = '-9999px';
  document.body.appendChild(field);
  field.select();

  let copied = false;

  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }

  field.remove();
  return copied;
}

function showCopyFeedback(message) {
  const status = $('invite-status');

  if (!status) return;

  status.textContent = message;
  clearTimeout(copyFeedbackTimer);
  copyFeedbackTimer = setTimeout(() => {
    if (status.isConnected) status.textContent = '';
  }, 3000);
}

function draftKey() {
  return `story-draft-${state.code}-${state.gameId}`;
}

function name(id) {
  return (
    state.players.find(player => player.id === id)?.name ||
    'Unknown player'
  );
}

const AVATARS = [
  '<path d="M9 10h30v27H9zM9 14l15 9 15-9M9 37l12-12m18 12L27 25"/>',
  '<path d="M8 15l8-8 8 7 8-7 8 8-4 22H12zM14 22l8 5m12-5-8 5m-7 7h10"/>',
  '<path d="M11 38 30 9l7 5-19 29-9 2zM25 17l7 5M7 45h34"/>',
  '<path d="M24 5C25 16 13 18 13 30a11 11 0 0 0 22 0c0-6-4-10-7-13 0 8-5 9-5 15a4 4 0 0 1-4-4c0-8 8-13 5-23z"/>',
  '<path d="M4 24s7-13 20-13 20 13 20 13-7 13-20 13S4 24 4 24z"/><circle cx="24" cy="24" r="6"/>',
  '<path d="M24 5v8m0 22v8M5 24h8m22 0h8M10.5 10.5l5.7 5.7m15.6 15.6 5.7 5.7m0-27-5.7 5.7m-15.6 15.6-5.7 5.7"/><circle cx="24" cy="24" r="12"/>',
  '<path d="M8 8h28v28H8z"/><circle cx="16" cy="16" r="2"/><circle cx="28" cy="16" r="2"/><circle cx="22" cy="22" r="2"/><circle cx="16" cy="28" r="2"/><circle cx="28" cy="28" r="2"/>',
  '<path d="M24 6 29 17l12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1z"/>'
];

function avatar(player) {
  const initial = Array.from(String(player.name || '').trim())[0] || '?';
  const color = /^#[\da-f]{6}$/i.test(player.avatarColor)
    ? player.avatarColor
    : '#ff6b7b';

  return `
    <span class="avatar" style="--avatar-color:${color}" aria-hidden="true">
      ${escapeHTML(initial.toLocaleUpperCase())}
    </span>
  `;
}

function connectionIcon(player) {
  const connected = Boolean(player?.connected);

  return `
    <span
      class="connection-icon ${connected ? 'is-online' : 'is-offline'}"
      role="img"
      aria-label="${connected ? 'Connected' : 'Disconnected'}"
      title="${connected ? 'Connected' : 'Disconnected'}"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        ${connected
          ? '<path d="m5 12.5 4.5 4.5L19 7.5"/>'
          : '<path d="m7 7 10 10M17 7 7 17"/>'}
      </svg>
    </span>
  `;
}

function questionMarkIcon() {
  return `
    <svg class="badge-question" viewBox="0 0 64 76" aria-hidden="true">
      <path d="M19 18c-7-3-10-9-8-15 4 5 8 7 13 8"/>
      <path d="M45 18c7-3 10-9 8-15-4 5-8 7-13 8"/>
      <path d="M13 33c0-13 8-22 19-22s19 9 19 22c0 10-7 14-13 20-3 3-4 5-4 9H29c0-8 3-12 8-17 5-5 8-8 8-13 0-7-5-12-13-12s-13 5-13 13H13zM28 68h9v7h-9z"/>
    </svg>
  `;
}

function typeStory(element, text) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const words = text.match(/\S+\s*/g) || [text];
  const delay = Math.max(14, Math.min(42, 3200 / words.length));
  let index = 0;

  element.textContent = '';
  element.setAttribute('aria-label', text);

  const revealWord = () => {
    element.textContent += words[index++];

    if (index < words.length) {
      setTimeout(revealWord, delay);
    }
  };

  revealWord();
}

async function send(event, data = {}) {
  $('error').textContent = '';

  if (!socket.connected) {
    throw new Error('Disconnected. Waiting to reconnect…');
  }

  const result = await socket
    .timeout(8000)
    .emitWithAck(event, data);

  if (!result.ok) {
    throw new Error(result.error);
  }

  if (result.session) {
    save(sessionKey, result.session);
  }

  return result;
}

async function action(event, data) {
  if (pending) return;

  pending = true;

  try {
    await send(event, data);
  } catch (error) {
    $('error').textContent = error.message;
  } finally {
    pending = false;
  }
}

socket.on('connect', async () => {
  $('connection').textContent = 'Connected';

  const session = read(sessionKey);

  if (session) {
    try {
      await send('resume', {
        ...session,
        role
      });
    } catch (error) {
      // Keep credentials during temporary timeouts.
      if (
        error.message.includes('expired') ||
        error.message.includes('invalid')
      ) {
        localStorage.removeItem(sessionKey);
      }

      $('error').textContent = error.message;
    }
  }
});

socket.on('disconnect', reason => {
  $('connection').textContent =
    reason === 'io server disconnect'
      ? 'Seat opened in another tab. Close this tab.'
      : 'Disconnected — reconnecting…';
});

socket.on('connect_error', () => {
  $('connection').textContent =
    'Cannot connect — retrying…';
});

socket.on('closed', message => {
  localStorage.removeItem(sessionKey);

  state = null;
  renderKey = null;

  initial();

  $('notice').textContent = message;
});

socket.on('state', next => {
  state = next;
  render();
});

function initial() {
  screen.innerHTML = role === 'host'
    ? `
      <section class="panel host-home-screen">
        <div class="brand home-brand" aria-label="Story Warz">
          <svg class="brand-mark" viewBox="0 0 64 76" aria-hidden="true">
            <path d="M19 18c-7-3-10-9-8-15 4 5 8 7 13 8"/>
            <path d="M45 18c7-3 10-9 8-15-4 5-8 7-13 8"/>
            <path d="M13 33c0-13 8-22 19-22s19 9 19 22c0 10-7 14-13 20-3 3-4 5-4 9H29c0-8 3-12 8-17 5-5 8-8 8-13 0-7-5-12-13-12s-13 5-13 13H13zM28 68h9v7h-9z"/>
          </svg>
          <span>STORY <b>WARZ</b></span>
        </div>

        <button id="create">Create room</button>
      </section>
    `
    : `
      <section class="panel">
        <h1 class="hero-title player-hero-title">Prepare for War.</h1>

        <form id="join-form">
          <label for="code">Room code</label>

          <input
            id="code"
            maxlength="4"
            pattern="[A-Za-z]{4}"
            autocapitalize="characters"
            autocomplete="off"
            required
          >

          <label for="name">Your name</label>

          <input
            id="name"
            maxlength="15"
            autocomplete="nickname"
            required
          >

          <button>Join room</button>
        </form>

        <p class="muted">
          Hosting on a computer?

          <a class="button quiet" href="/host">
            Host screen
          </a>
        </p>
      </section>
    `;

  if (role === 'host') {
    $('create').onclick = () => action('create');
  } else {
    const code =
      new URLSearchParams(location.search).get('room') || '';

    $('code').value = code.slice(0, 4).toUpperCase();

    $('join-form').onsubmit = event => {
      event.preventDefault();

      action('join', {
        code: $('code').value,
        name: $('name').value
      });
    };
  }
}

function roster() {
  return '<div id="roster" class="grid"></div>';
}

function leaderboard(finalScore = false) {
  return [...state.players]
    .sort((a, b) => b.score - a.score)
    .map((player, index) => `
      <div class="row score-row ${finalScore ? `final-rank rank-${Math.min(index + 1, 3)}` : ''}">
        ${finalScore ? `<span class="rank-badge">${index === 0 ? '1st' : `${index + 1}${index === 1 ? 'nd' : index === 2 ? 'rd' : 'th'}`}</span>` : ''}
        <span class="identity">
          ${connectionIcon(player)}
          ${escapeHTML(player.name)}
        </span>
        <b>${player.score} pts</b>
      </div>
    `)
    .join('');
}

function champion() {
  return [...state.players].sort((a, b) => b.score - a.score)[0];
}

function scorePanel(finalScore = false) {
  const scores = leaderboard(finalScore);
  const title = finalScore ? 'Final scores' : 'Scores';

  return role === 'host' || finalScore
    ? `
      <aside class="score-panel ${finalScore ? 'final-score-panel' : ''}">
        <div class="score-panel-heading">
          ${finalScore ? '<span class="champion-mark" aria-hidden="true">✦</span>' : ''}
          <h2>${title}</h2>
        </div>
        <div class="score-list">${scores}</div>
      </aside>
    `
    : `
      <details class="phone-score-menu ${finalScore ? 'final-score-menu' : ''}">
        <summary>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 19h16M6 16V9m6 7V5m6 11v-4"/>
          </svg>
          ${title}
        </summary>
        <div class="phone-score-popover">
          <h2>${title}</h2>
          <div class="score-list">${scores}</div>
        </div>
      </details>
    `;
}

function render() {
  const s = state;
  const r = s.round;

  if ($('phone-controller-eyebrow')) {
    $('phone-controller-eyebrow').hidden = s.phase !== 'lobby';
  }

  if ($('end-game')) $('end-game').hidden = s.phase === 'lobby';

  $('notice').textContent = !s.hostConnected
    ? 'Host disconnected. Keep this page open while they reconnect.'
    : '';

  // Preserve forms and focus when only player statuses change.
  const key = [
    s.gameId,
    s.phase,
    r?.id,
    s.me?.ready,
    s.me?.voted
  ].join(':');

  if (key !== renderKey) {
    renderKey = key;

    const heading = role === 'host' && s.phase === 'lobby'
      ? ''
      : `
        <div class="room-heading">
          <p class="eyebrow">ROOM ${escapeHTML(s.code)}</p>
        </div>
      `;

    let content = '';

    if (s.phase === 'lobby') {
      content = role === 'host'
        ? `
          <div class="lobby-title-row">
            <h1 class="hero-title">
              <span class="hero-story">Story</span>
              <span class="hero-warz">Warz</span>
            </h1>
            <p class="eyebrow room-code-eyebrow">
              ROOM ${escapeHTML(s.code)}
            </p>
          </div>

          <div class="invite-block">
            <p class="invite-label">
              <span class="invite-pulse" aria-hidden="true"></span>
              Phones on host wifi!
            </p>
            <button
              id="invite"
              class="invite-link"
              type="button"
              aria-label="Copy phone link to clipboard"
            ></button>
            <p id="invite-status" class="invite-status" role="status" aria-live="polite"></p>
          </div>

          <button
            id="room-code"
            class="code"
            type="button"
            title="Copy room code"
            aria-label="Copy room code ${escapeHTML(s.code)}"
          >${escapeHTML(s.code)}</button>

          ${roster()}

          <form id="start-form" class="host-setup">
            <label for="theme-toggle">Story category</label>

            <div class="theme-picker">
              <button
                id="theme-toggle"
                class="theme-toggle"
                type="button"
                aria-haspopup="listbox"
                aria-expanded="false"
                aria-controls="theme-menu"
              >
                <span id="theme-value">
                  ${escapeHTML(s.themes[Number(config.theme)]?.[0] || s.themes[0][0])}
                </span>
                <span class="theme-toggle-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="m7 10 5 5 5-5"/>
                    <path d="M8 6h8"/>
                  </svg>
                </span>
              </button>
              <div
                id="theme-menu"
                class="theme-menu"
                role="listbox"
                aria-label="Story category"
                hidden
              >
                ${s.themes.map((theme, index) => `
                  <button
                    class="theme-option"
                    type="button"
                    role="option"
                    aria-selected="${index === Number(config.theme)}"
                    data-theme="${index}"
                  >
                    ${escapeHTML(theme[0])}
                  </button>
                `).join('')}
              </div>
            </div>

            <label for="custom">
              Or enter a custom theme
            </label>

            <input id="custom" maxlength="80">

            <button>Start writing</button>
          </form>

          <p class="muted">
            Need 3–8 connected players.
            The host plays by joining on a phone.
          </p>
        `
        : `
          <h1>
            You’re in, ${escapeHTML(name(s.me.id))}.
          </h1>

          <p>
            Waiting for the host to choose a theme
            and start.
          </p>

          ${roster()}
        `;
    } else if (s.phase === 'writing') {
      content = `
        <h1>${escapeHTML(s.theme[0])}</h1>
        <p>${escapeHTML(s.theme[1])}</p>
      `;

      if (role === 'host') {
        content += `
          <p>
            Write 3–5 true stories on your phone.
            Keep the author a secret.
          </p>

          ${roster()}

          <button id="begin">Start</button>
        `;
      } else if (s.me.ready) {
        content += `
          <h2>Stories locked in!</h2>

          <p>
            Watch the shared screen while everyone
            finishes.
          </p>

          ${roster()}
        `;
      } else {
        content += `
          <p>
            Write at least 3 true stories.
            The last 2 are optional.
            Maximum 500 characters each.
          </p>

          <form id="stories-form">
            ${Array.from({ length: 5 }, (_, index) => `
              <label for="story-${index}">
                Story ${index + 1}
                ${index > 2 ? '(optional)' : ''}
              </label>

              <textarea
                id="story-${index}"
                maxlength="500"
                ${index < 3 ? 'required' : ''}
              ></textarea>
            `).join('')}

            <button>Lock in stories</button>
          </form>
        `;
      }
    } else if (s.phase === 'guessing') {
      content = `
        <div class="round-meta">
          <span class="round-number">
          Story ${r.number} of ${r.total}
          </span>
          ${r.multiplier === 2
            ? `<span class="badge">${questionMarkIcon()}<strong>DOUBLE POINTS</strong>${questionMarkIcon()}</span>`
            : ''}
        </div>

        <h1>Who wrote this?</h1>

        <p class="story" id="story-text">${escapeHTML(r.text)}</p>

        <p id="progress" aria-live="polite"></p>
      `;

      if (role === 'host') {
        content += `
          <button id="speak" class="quiet">
            Read aloud
          </button>
        `;
      } else if (s.me.voted) {
        content += '<h2>Guess locked in.</h2>';
      } else {
        content += `
          <p>Choose a name, then swipe right on it to lock in your vote.</p>

          <div class="grid vote-grid">
            ${s.players.filter(player => player.id !== s.me.id).map(player => `
              <button class="vote-choice" data-vote="${player.id}" aria-pressed="false">
                <span>${escapeHTML(player.name)}</span>
                <span class="vote-swipe-hint" aria-hidden="true">&rarr;</span>
              </button>
            `).join('')}
          </div>
          <p id="vote-hint" class="vote-hint" aria-live="polite">Tap a name to select it.</p>
          <button id="lock-vote" class="vote-lock" type="button" disabled>Lock in vote</button>
        `;
      }
    } else if (s.phase === 'reveal') {
      content = `
        ${role === 'player' ? scorePanel() : ''}
        <div class="results-layout">
          <div class="results-main">
            <p class="eyebrow">THE AUTHOR WAS…</p>
            <h1>${escapeHTML(name(r.authorId))}!</h1>
            <p class="story">${escapeHTML(r.text)}</p>

            <div class="round-results">
              ${r.results.map(result => {
                const player = s.players.find(item => item.id === result.playerId);
                const detail = result.author
                  ? `Fooled ${result.fooled} player(s)`
                  : result.guess
                    ? `Guessed ${escapeHTML(name(result.guess))}`
                    : 'No guess';

                return `
                  <div class="result-row ${result.author ? 'is-author' : ''}">
                    <span class="identity result-player">
                      ${connectionIcon(player)}
                      <strong>${escapeHTML(name(result.playerId))}</strong>
                    </span>
                    <span class="result-detail">${detail}</span>
                    <b>+${result.points}</b>
                  </div>
                `;
              }).join('')}
            </div>

            <p class="storytime-note">
              Storytime! Let the author tell the full backstory.
            </p>

            ${role === 'host'
              ? '<button id="next">Next story</button>'
              : '<p class="muted">Waiting for the host…</p>'}
          </div>
          ${role === 'host' ? scorePanel() : ''}
        </div>
      `;
    } else if (s.phase === 'finished') {
      content = `
        ${role === 'player' ? scorePanel(true) : ''}
        <div class="results-layout finished-layout">
          <div class="results-main">
            <p class="eyebrow">THE FINAL STANDINGS</p>
            <div class="champion-reveal">
              <span class="champion-crown" aria-hidden="true">&#10022;</span>
              <p class="eyebrow">STORY WARZ CHAMPION</p>
              <h1>${escapeHTML(champion()?.name || 'Champion')}</h1>
              <p class="champion-score">${champion()?.score || 0} points</p>
            </div>
            ${role === 'host'
              ? '<button id="story-archive">Look through every story</button>'
              : '<p>Waiting for the host to start another game.</p>'}
          </div>
          ${role === 'host' ? scorePanel(true) : ''}
        </div>
      `;
    }

    if (s.phase === 'archive') {
      content = `
        <div class="archive-heading">
          <p class="eyebrow">THE WHOLE STORY</p>
          <h1>Story vault</h1>
          <p>Every story submitted this game, with its author and whether it made the ten-round deck.</p>
        </div>
        <div class="story-archive">
          ${(s.storyArchive || []).map(story => `
            <article class="archive-story ${story.used ? 'was-played' : 'not-played'}">
              <div class="archive-story-meta">
                <span class="archive-status">${story.used ? 'Played in game' : 'Not played'}</span>
                <span class="archive-author">${escapeHTML(name(story.authorId))}</span>
              </div>
              <p>${escapeHTML(story.text)}</p>
            </article>
          `).join('')}
        </div>
        ${role === 'host' ? '<button id="home">Home</button>' : '<p class="muted">The host will start another game when everyone is ready.</p>'}
      `;
    }

    screen.innerHTML = `
      <section class="panel">
        ${heading}
        ${content}
      </section>
    `;

    wire();

    if (s.phase === 'guessing' && animatedRound !== r.id) {
      animatedRound = r.id;
      typeStory($('story-text'), r.text);
    }
  }

  if ($('roster')) {
    $('roster').innerHTML = s.players.map(player => `
      <div class="person ${role === 'host' && !player.connected ? 'has-remove' : ''}">
        <span class="identity">
          ${connectionIcon(player)}
          ${escapeHTML(player.name)}
        </span>

        <small>
          <span class="connection-label ${player.connected ? 'is-online' : 'is-offline'}">
            ${player.connected ? 'Online' : 'Reconnecting'}
          </span>

          ${
            s.phase === 'writing'
              ? player.ready
                ? '<span class="ready-label">Ready</span>'
                : '<span class="ready-label">Writing</span>'
              : ''
          }
        </small>

        ${
          role === 'host' &&
          s.phase === 'lobby' &&
          !player.connected
            ? `
              <button
                class="quiet"
                data-remove="${player.id}"
                aria-label="Remove ${escapeHTML(player.name)}"
                title="Remove ${escapeHTML(player.name)}"
              >
                ×
              </button>
            `
            : ''
        }
      </div>
    `).join('');
  }

  document
    .querySelectorAll('[data-remove]')
    .forEach(button => {
      button.onclick = () => action('remove', {
        playerId: button.dataset.remove
      });
    });

  if ($('begin')) {
    $('begin').disabled = !s.players.every(
      player => player.ready
    );
  }

  updateProgress();
}

function wire() {
  if ($('invite')) {
    const localHost = ['localhost', '127.0.0.1', '::1']
      .includes(location.hostname);
    const origin = localHost
      ? state.phoneOrigin || location.origin
      : location.origin;
    const inviteUrl = `${origin}/`;
    $('invite').textContent = inviteUrl;
    $('invite').onclick = async () => {
      const copied = await copyText(inviteUrl);
      showCopyFeedback(copied
        ? 'Phone link copied to clipboard'
        : 'Could not copy automatically. Select the address to copy it.');
      $('invite').setAttribute(
        'aria-label',
        copied ? 'Phone link copied to clipboard' : 'Copy phone link to clipboard'
      );
    };
  }

  if ($('room-code')) {
    $('room-code').onclick = async () => {
      const copied = await copyText(state.code);
      showCopyFeedback(copied
        ? 'Room code copied to clipboard'
        : 'Could not copy the room code automatically.');
    };
  }

  if ($('start-form')) {
    $('custom').value = config.custom;

    const toggle = $('theme-toggle');
    const menu = $('theme-menu');
    const themeOptions = [...menu.querySelectorAll('[data-theme]')];

    const closeThemeMenu = restoreFocus => {
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus) toggle.focus();
    };

    const openThemeMenu = focusSelected => {
      menu.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');

      if (focusSelected) {
        (themeOptions.find(option => option.getAttribute('aria-selected') === 'true') || themeOptions[0]).focus();
      }
    };

    toggle.onclick = () => {
      if (menu.hidden) openThemeMenu(false);
      else closeThemeMenu(false);
    };

    toggle.onkeydown = event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openThemeMenu(true);
      }
    };

    themeOptions.forEach((option, index) => {
      option.onclick = () => {
        config.theme = option.dataset.theme;
        $('theme-value').textContent = option.textContent.trim();

        themeOptions.forEach(item => {
          const selected = item === option;
          item.setAttribute('aria-selected', String(selected));
        });

        closeThemeMenu(false);
        toggle.focus();
      };

      option.onkeydown = event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeThemeMenu(true);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          themeOptions[(index + direction + themeOptions.length) % themeOptions.length].focus();
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          themeOptions[event.key === 'Home' ? 0 : themeOptions.length - 1].focus();
        }
      };
    });

    document.onclick = event => {
      if (!event.target.closest('.theme-picker')) {
        closeThemeMenu(false);
      }
    };

    $('custom').oninput = () => {
      config.custom = $('custom').value;
    };

    $('start-form').onsubmit = event => {
      event.preventDefault();

      action('start', config);
    };
  }

  if ($('stories-form')) {
    const draft = read(draftKey()) || [];

    for (let index = 0; index < 5; index++) {
      $('story-' + index).value = draft[index] || '';
    }

    const values = () =>
      Array.from(
        { length: 5 },
        (_, index) => $('story-' + index).value
      );

    $('stories-form').oninput = () => {
      save(draftKey(), values());
    };

    $('stories-form').onsubmit = event => {
      event.preventDefault();

      action('stories', {
        stories: values()
          .map(text => text.trim())
          .filter(Boolean)
      });
    };
  }

  if ($('begin')) {
    $('begin').onclick = () => {
      playNextStoryCue(false);
      action('begin');
    };
  }

  if ($('next')) {
    $('next').onclick = () => {
      playNextStoryCue(state.round.number === 5);

      action('next', {
        roundId: state.round.id
      });
    };
  }

  if ($('home')) {
    $('home').onclick = () => action('end');
  }

  if ($('story-archive')) {
    $('story-archive').onclick = () => action('archive');
  }

  if ($('end-game')) {
    $('end-game').onclick = () => action('end');
  }

  let selectedVote = null;
  const voteChoices = [...document.querySelectorAll('[data-vote]')];
  const lockVote = () => {
    if (selectedVote) action('vote', {
      authorId: selectedVote,
      roundId: state.round.id
    });
  };

  voteChoices.forEach(button => {
    button.onclick = () => {
      selectedVote = button.dataset.vote;
      voteChoices.forEach(choice => {
        const selected = choice === button;
        choice.classList.toggle('is-selected', selected);
        choice.setAttribute('aria-pressed', String(selected));
      });
      if ($('vote-hint')) $('vote-hint').textContent = 'Swipe right on the selected name, or use the button below.';
      if ($('lock-vote')) $('lock-vote').disabled = false;
    };

    let startX = 0;
    let startY = 0;
    button.onpointerdown = event => { startX = event.clientX; startY = event.clientY; };
    button.onpointerup = event => {
      if (selectedVote === button.dataset.vote && event.clientX - startX > 60 && Math.abs(event.clientY - startY) < 55) {
        event.preventDefault();
        lockVote();
      }
    };
  });

  if ($('lock-vote')) $('lock-vote').onclick = lockVote;

  if ($('speak')) {
    $('speak').onclick = () => {
      if (!('speechSynthesis' in window)) {
        $('error').textContent =
          'Speech is unavailable in this browser.';

        return;
      }

      speechSynthesis.cancel();

      speechSynthesis.speak(
        new SpeechSynthesisUtterance(state.round.text)
      );
    };
  }
}

function updateProgress() {
  if (state?.round) {
    const round = state.round;
    if ($('progress')) {
      $('progress').textContent =
        `${round.voteCount}/${round.requiredVotes} votes in`;
    }

    const countdown = $('countdown-overlay');

    if (countdown) {
      const seconds = Number.isInteger(round.revealCountdown)
        ? round.revealCountdown
        : 0;
      countdown.hidden = seconds < 1;
      $('countdown-number').textContent = String(seconds);
    }
  } else if ($('countdown-overlay')) {
    $('countdown-overlay').hidden = true;
  }
}

if ($('rules')) {
  $('rules').onclick = () => {
    $('rules-dialog').showModal();
  };
}

if ($('close-rules')) {
  $('close-rules').onclick = () => {
    $('rules-dialog').close();
  };
}

initial();
