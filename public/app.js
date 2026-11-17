const $ = id => document.getElementById(id);

const role = document.body.dataset.role;
const socket = io();

const sessionKey = `story-wars-${role}`;
const screen = $('screen');

let state;
let renderKey;
let pending = false;
let offset = 0;

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

function draftKey() {
  return `story-draft-${state.code}-${state.gameId}`;
}

function name(id) {
  return (
    state.players.find(player => player.id === id)?.name ||
    'Unknown player'
  );
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

  $('error').textContent = message;
});

socket.on('state', next => {
  state = next;
  offset = next.serverNow - Date.now();

  render();
});

function initial() {
  screen.innerHTML = role === 'host'
    ? `
      <section class="panel">
        <h1>Your friends have stories.</h1>

        <p>
          Put this screen on the TV.
          Everyone joins on their own phone.
        </p>

        <button id="create">Create room</button>
      </section>
    `
    : `
      <section class="panel">
        <h1>Join the story.</h1>

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

function leaderboard() {
  return [...state.players]
    .sort((a, b) => b.score - a.score)
    .map(player => `
      <div class="row">
        <span>${escapeHTML(player.name)}</span>
        <b>${player.score} pts</b>
      </div>
    `)
    .join('');
}

function render() {
  const s = state;
  const r = s.round;

  $('notice').textContent = !s.hostConnected
    ? 'Host disconnected. Keep this page open while they reconnect.'
    : '';

  // Preserve forms and focus when only player statuses change.
  const key = [
    s.gameId,
    s.phase,
    r?.id,
    s.me?.ready,
    s.me?.voted,
    s.me?.isAuthor
  ].join(':');

  if (key !== renderKey) {
    renderKey = key;

    const heading = `
      <p class="eyebrow">
        ROOM ${escapeHTML(s.code)}
      </p>
    `;

    let content = '';

    if (s.phase === 'lobby') {
      content = role === 'host'
        ? `
          <h1>Ready for a story?</h1>

          <p>Join on your phone at:</p>
          <p id="invite"></p>

          <div class="code">${s.code}</div>

          ${roster()}

          <form id="start-form">
            <label for="theme">Story category</label>

            <select id="theme">
              ${s.themes.map((theme, index) => `
                <option value="${index}">
                  ${escapeHTML(theme[0])}
                </option>
              `).join('')}
            </select>

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

          <button id="begin">Start guessing</button>
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
        <p>
          Story ${r.number} of ${r.total}

          <span class="badge">
            ${r.multiplier === 2 ? '🔥 DOUBLE POINTS' : ''}
          </span>
        </p>

        <h1>Who wrote this?</h1>

        <p class="story">${escapeHTML(r.text)}</p>

        <p id="progress" aria-live="polite"></p>
      `;

      if (role === 'host') {
        content += `
          <button id="speak" class="quiet">
            Read aloud
          </button>
        `;
      } else if (s.me.isAuthor) {
        content += `
          <h2>This one is yours. Play it cool.</h2>
        `;
      } else if (s.me.voted) {
        content += '<h2>Guess locked in.</h2>';
      } else {
        content += `
          <p>
            Correct guess: +${2 * r.multiplier} points
          </p>

          <div class="grid">
            ${s.players.map(player => `
              <button data-vote="${player.id}">
                ${escapeHTML(player.name)}
              </button>
            `).join('')}
          </div>
        `;
      }
    } else if (s.phase === 'reveal') {
      content = `
        <p class="eyebrow">THE AUTHOR WAS…</p>

        <h1>${escapeHTML(name(r.authorId))}!</h1>

        <p class="story">${escapeHTML(r.text)}</p>

        ${r.results.map(result => `
          <div class="row">
            <span>
              ${escapeHTML(name(result.playerId))}:

              ${
                result.author
                  ? `fooled ${result.fooled} player(s)`
                  : result.guess
                    ? `guessed ${escapeHTML(name(result.guess))}`
                    : 'no vote'
              }
            </span>

            <b>+${result.points}</b>
          </div>
        `).join('')}

        <p>
          Storytime! Let the author tell the full backstory.
        </p>

        <h2>Scores</h2>

        ${leaderboard()}

        ${
          role === 'host'
            ? '<button id="next">Continue</button>'
            : '<p class="muted">Waiting for the host…</p>'
        }
      `;
    } else if (s.phase === 'finished') {
      content = `
        <h1>🏆 That’s a wrap!</h1>

        ${leaderboard()}

        ${
          role === 'host'
            ? '<button id="replay">Play again</button>'
            : '<p>Waiting for the host to start another game.</p>'
        }
      `;
    }

    screen.innerHTML = `
      <section class="panel">
        ${heading}
        ${content}
      </section>
    `;

    wire();
  }

  if ($('roster')) {
    $('roster').innerHTML = s.players.map(player => `
      <div class="person">
        ${escapeHTML(player.name)}

        <small>
          ${player.connected ? '● Online' : '○ Reconnecting'}

          ${
            s.phase === 'writing'
              ? player.ready
                ? ' · Ready ✓'
                : ' · Writing…'
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
              >
                Remove
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

  updateClock();
}

function wire() {
  if ($('invite')) {
    $('invite').textContent =
      `${location.origin}/?room=${state.code}`;
  }

  if ($('start-form')) {
    $('theme').value = config.theme;
    $('custom').value = config.custom;

    $('theme').onchange = () => {
      config.theme = $('theme').value;
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
    $('begin').onclick = () => action('begin');
  }

  if ($('next')) {
    $('next').onclick = () => action('next', {
      roundId: state.round.id
    });
  }

  if ($('replay')) {
    $('replay').onclick = () => action('replay');
  }

  document
    .querySelectorAll('[data-vote]')
    .forEach(button => {
      button.onclick = () => action('vote', {
        authorId: button.dataset.vote,
        roundId: state.round.id
      });
    });

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

function updateClock() {
  if ($('progress') && state?.round) {
    const seconds = Math.max(
      0,
      Math.ceil(
        (state.deadline - Date.now() - offset) / 1000
      )
    );

    $('progress').textContent =
      `${state.round.voteCount}/${state.round.requiredVotes}` +
      ` guesses · ${seconds}s remaining`;
  }
}

setInterval(updateClock, 250);

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