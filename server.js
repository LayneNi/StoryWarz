const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { randomBytes, randomInt, randomUUID } = require('node:crypto');
const { networkInterfaces } = require('node:os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 16000
});

const rooms = new Map();
const AVATAR_COLORS = [
  '#ff8792',
  '#ffc65f',
  '#7be4ad',
  '#73c9ff',
  '#d5a0ff',
  '#ffa66e',
  '#f2a4ca',
  '#a9d975'
];
const port = Number(process.env.PORT) || 3000;

const THEMES = [
  ['Summer', 'Beach trips, heatwaves, summer jobs, or outdoor adventures.'],
  [
    'Alcohol & Nights Out',
    'Wild nights, party mishaps, or morning-after realizations.'
  ],
  ['School Days', 'Teachers, tests, and school or college memories.'],
  ['The Cold & Winter', 'Snowstorms, winter driving, or freezing adventures.'],
  [
    'Seasonal & Holidays',
    'Holiday chaos, family dinners, or New Year’s Eve.'
  ],
  [
    'Travel & Road Trips',
    'Missed flights, bad hotels, or road trip adventures.'
  ],
  [
    'Jobs & Work',
    'Awkward bosses, crazy customers, or workplace disasters.'
  ],
  [
    'Childhood & Family',
    'Siblings, parents, and memories of growing up.'
  ],
  ['Injuries & Close Calls', 'Stitches, broken bones, or lucky escapes.'],
  ['Food & Dining', 'Restaurant disasters or terrible cooking experiments.']
];

const token = () => randomBytes(24).toString('hex');

const fail = message => {
  throw new Error(message);
};

app.get('/host', (_, res) => {
  res.sendFile(path.join(__dirname, 'public/host.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

function roomCode() {
  let code;

  do {
    code = Array.from(
      { length: 4 },
      () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[randomInt(26)]
    ).join('');
  } while (rooms.has(code));

  return code;
}

function current(room) {
  return room.deck[room.index];
}

function multiplier(room) {
  return room.index >= 5 ? 2 : 1;
}

function active(socket) {
  const room = rooms.get(socket.data.code);

  if (!room) {
    fail('Room expired. Create or join another room.');
  }

  return room;
}

function host(socket) {
  const room = active(socket);

  if (room.hostSocket !== socket.id) {
    fail('Only the host can do that.');
  }

  return room;
}

function player(socket) {
  const room = active(socket);

  const person = room.players.find(
    p => p.id === socket.data.playerId && p.socket === socket.id
  );

  if (!person) {
    fail('Join as a player first.');
  }

  return [room, person];
}

function phoneOrigin() {
  const interfaces = Object.entries(networkInterfaces()).flatMap(
    ([name, addresses]) => (addresses || []).map(address => ({
      name,
      ...address
    }))
  );
  const ipv4 = interfaces.filter(
    address => address.family === 'IPv4' && !address.internal
  );
  const address =
    ipv4.find(item => /wi-?fi|wireless|ethernet/i.test(item.name)) || ipv4[0];

  return address
    ? `http://${address.address}:${port}`
    : `http://localhost:${port}`;
}

// Build a separate view for each device.
// Unrevealed authors and other players' votes stay on the server.
function view(room, person) {
  const story = current(room);
  const revealing = room.phase === 'reveal';

  return {
    code: room.code,
    phase: room.phase,
    gameId: room.gameId,
    hostConnected: Boolean(room.hostSocket),
    phoneOrigin: phoneOrigin(),
    themes: THEMES,
    theme: room.theme,

    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      avatarColor: p.avatarColor,
      score: p.score,
      connected: Boolean(p.socket),
      ready: p.stories.length > 0,
      voted: Object.hasOwn(room.votes, p.id)
    })),

    me: person
      ? {
          id: person.id,
          ready: person.stories.length > 0,
          voted: Object.hasOwn(room.votes, person.id),
        }
      : null,

    round: ['guessing', 'reveal'].includes(room.phase)
      ? {
          id: room.roundId,
          number: room.index + 1,
          total: room.deck.length,
          text: story.text,
          multiplier: multiplier(room),
          voteCount: Object.keys(room.votes).length,
          requiredVotes: room.players.length,
          revealCountdown: room.revealCountdown,

          ...(revealing
            ? {
                authorId: story.authorId,
                results: room.results
              }
            : {})
        }
      : null
  };
}

function broadcast(room) {
  if (room.hostSocket) {
    io.to(room.hostSocket).emit('state', view(room));
  }

  for (const p of room.players) {
    if (p.socket) {
      io.to(p.socket).emit('state', view(room, p));
    }
  }
}

function reveal(room) {
  if (room.phase !== 'guessing') return;

  if (room.revealTimer) clearInterval(room.revealTimer);
  room.revealTimer = null;
  room.revealCountdown = null;

  const story = current(room);
  const author = room.players.find(p => p.id === story.authorId);

  room.results = [];

  let fooled = 0;

  for (const p of room.players) {
    const guess = room.votes[p.id];

    if (p.id === author.id) {
      room.results.push({
        playerId: p.id,
        author: true,
        guess: guess || null,
        fooled: 0,
        points: 0
      });
      continue;
    }

    const correct = guess === author.id;
    const points = correct ? 2 * multiplier(room) : 0;

    if (guess && !correct) {
      fooled++;
    }

    p.score += points;

    room.results.push({
      playerId: p.id,
      guess: guess || null,
      points
    });
  }

  const points = fooled * multiplier(room);

  author.score += points;

  const authorResult = room.results.find(result => result.author);
  authorResult.fooled = fooled;
  authorResult.points = points;

  room.phase = 'reveal';

  broadcast(room);
}

function nextStory(room) {
  room.index++;
  room.votes = {};
  room.revealCountdown = null;

  if (room.index >= room.deck.length) {
    room.phase = 'finished';
  } else {
    room.phase = 'guessing';
    room.roundId = randomUUID();
  }

  broadcast(room);
}

function startRevealCountdown(room) {
  room.revealCountdown = 5;
  broadcast(room);

  room.revealTimer = setInterval(() => {
    if (room.phase !== 'guessing') {
      clearInterval(room.revealTimer);
      room.revealTimer = null;
      return;
    }

    room.revealCountdown--;

    if (room.revealCountdown <= 0) {
      clearInterval(room.revealTimer);
      room.revealTimer = null;
      reveal(room);
    } else {
      broadcast(room);
    }
  }, 1000);
}

function resetToLobby(room) {
  if (room.revealTimer) clearInterval(room.revealTimer);

  room.revealTimer = null;
  room.revealCountdown = null;
  room.phase = 'lobby';
  room.gameId = randomUUID();
  room.theme = THEMES[0];
  room.deck = [];
  room.index = -1;
  room.roundId = null;
  room.votes = {};
  room.results = [];
  room.touched = Date.now();

  room.players.forEach(p => {
    p.score = 0;
    p.stories = [];
  });
}

function bind(socket, room, person) {
  const oldId = person ? person.socket : room.hostSocket;

  // Reconnecting replaces the previous connection for this seat.
  if (oldId && oldId !== socket.id) {
    io.sockets.sockets.get(oldId)?.disconnect(true);
  }

  socket.data.code = room.code;
  socket.data.playerId = person?.id;

  if (person) {
    person.socket = socket.id;
  } else {
    room.hostSocket = socket.id;
    room.hostGoneAt = null;
  }

  room.touched = Date.now();
}

io.on('connection', socket => {
  let windowStart = Date.now();
  let requests = 0;

  function on(event, handler) {
    socket.on(event, (data, ack) => {
      if (typeof ack !== 'function') return;

      try {
        if (Date.now() - windowStart > 10000) {
          windowStart = Date.now();
          requests = 0;
        }

        if (++requests > 50) {
          fail('Too many requests. Wait a few seconds.');
        }

        const result = handler(data || {});

        ack({ ok: true, ...result });
      } catch (error) {
        ack({
          ok: false,
          error: error.message
        });
      }
    });
  }

  on('create', () => {
    if (socket.data.code) {
      fail('This tab already has a room.');
    }

    if (rooms.size >= 500) {
      fail('Server is full. Try again later.');
    }

    const code = roomCode();

    const room = {
      code,
      hostToken: token(),
      hostSocket: null,
      hostGoneAt: null,
      players: [],
      phase: 'lobby',
      theme: THEMES[0],
      deck: [],
      index: -1,
      votes: {},
      revealCountdown: null,
      revealTimer: null,
      touched: Date.now(),
      gameId: randomUUID()
    };

    rooms.set(code, room);
    bind(socket, room);
    broadcast(room);

    return {
      session: {
        code,
        token: room.hostToken
      }
    };
  });

  on('resume', data => {
    if (socket.data.code) {
      fail('Already connected to a room.');
    }

    const room = rooms.get(String(data.code).toUpperCase());

    if (!room) {
      fail('Room expired. Create or join another room.');
    }

    if (data.role === 'host' && data.token === room.hostToken) {
      bind(socket, room);
    } else {
      const p = room.players.find(p => p.token === data.token);

      if (data.role !== 'player' || !p) {
        fail('Saved seat is invalid.');
      }

      bind(socket, room, p);
    }

    broadcast(room);

    return {};
  });

  on('join', data => {
    if (socket.data.code) {
      fail('This tab has already joined.');
    }

    const room = rooms.get(
      String(data.code).trim().toUpperCase()
    );

    if (!room) {
      fail('Room not found. Check the code.');
    }

    if (room.phase !== 'lobby') {
      fail('This game has started. Join the next game.');
    }

    if (room.players.length >= 8) {
      fail('Room is full (8 players).');
    }

    const name =
      typeof data.name === 'string' ? data.name.trim() : '';

    if (!name || name.length > 15) {
      fail('Enter a name with 1–15 characters.');
    }

    if (
      room.players.some(
        p => p.name.toLowerCase() === name.toLowerCase()
      )
    ) {
      fail('That name is already taken.');
    }

    const availableAvatarColors = AVATAR_COLORS.filter(
      color => !room.players.some(player => player.avatarColor === color)
    );

    const p = {
      id: randomUUID(),
      token: token(),
      name,
      score: 0,
      avatarColor: availableAvatarColors[
        randomInt(availableAvatarColors.length)
      ],
      stories: [],
      socket: null
    };

    room.players.push(p);

    bind(socket, room, p);
    broadcast(room);

    return {
      session: {
        code: room.code,
        token: p.token
      }
    };
  });

  on('start', data => {
    const room = host(socket);

    if (room.phase !== 'lobby') {
      fail('Game already started.');
    }

    if (
      room.players.length < 3 ||
      room.players.some(p => !p.socket)
    ) {
      fail('Need 3–8 connected players.');
    }

    const custom =
      typeof data.custom === 'string' ? data.custom.trim() : '';

    if (custom.length > 80) {
      fail('Custom theme must be 80 characters or fewer.');
    }

    room.theme = custom
      ? [custom, `Share completely true stories about ${custom}.`]
      : THEMES[Number(data.theme)] || THEMES[0];

    room.phase = 'writing';

    broadcast(room);

    return {};
  });

  on('remove', data => {
    const room = host(socket);

    if (room.phase !== 'lobby') {
      fail('Players can only be removed in the lobby.');
    }

    const p = room.players.find(p => p.id === data.playerId);

    if (!p || p.socket) {
      fail('Only disconnected players can be removed.');
    }

    room.players = room.players.filter(
      p => p.id !== data.playerId
    );

    broadcast(room);

    return {};
  });

  on('stories', data => {
    const [room, p] = player(socket);

    if (room.phase !== 'writing' || p.stories.length) {
      fail('Stories are already locked.');
    }

    if (
      !Array.isArray(data.stories) ||
      data.stories.length < 3 ||
      data.stories.length > 5 ||
      data.stories.some(
        s =>
          typeof s !== 'string' ||
          !s.trim() ||
          s.trim().length > 500
      )
    ) {
      fail('Submit 3–5 stories, each 1–500 characters.');
    }

    p.stories = data.stories.map(s => s.trim());

    broadcast(room);

    return {};
  });

  on('begin', () => {
    const room = host(socket);

    if (
      room.phase !== 'writing' ||
      !room.players.every(p => p.stories.length)
    ) {
      fail('Wait for every player to submit.');
    }

    const deck = room.players.flatMap(p =>
      p.stories.map(text => ({
        text,
        authorId: p.id
      }))
    );

    for (let i = deck.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    room.deck = deck.slice(0, 10);

    nextStory(room);

    return {};
  });

  on('vote', data => {
    const [room, p] = player(socket);

    if (
      room.phase !== 'guessing' ||
      data.roundId !== room.roundId
    ) {
      fail('That story has ended.');
    }

    if (Object.hasOwn(room.votes, p.id)) {
      fail('Your vote is already locked.');
    }

    if (
      !room.players.some(
        candidate => candidate.id === data.authorId
      )
    ) {
      fail('Invalid player.');
    }

    if (data.authorId === p.id) {
      fail('You cannot vote for yourself.');
    }

    room.votes[p.id] = data.authorId;

    if (
      Object.keys(room.votes).length === room.players.length
    ) {
      startRevealCountdown(room);
    } else {
      broadcast(room);
    }

    return {};
  });

  on('next', data => {
    const room = host(socket);

    if (
      room.phase !== 'reveal' ||
      data.roundId !== room.roundId
    ) {
      fail('Wait for the reveal.');
    }

    nextStory(room);

    return {};
  });

  on('end', () => {
    const room = host(socket);

    if (room.revealTimer) clearInterval(room.revealTimer);

    const code = room.code;
    const socketIds = [room.hostSocket, ...room.players.map(p => p.socket)]
      .filter(Boolean);

    for (const id of socketIds) {
      const participant = io.sockets.sockets.get(id);

      if (participant) {
        participant.data = {};
        io.to(id).emit(
          'closed',
          'The host ended the game. Create or join a room to play again.'
        );
      }
    }

    rooms.delete(code);

    return {};
  });

  on('replay', () => {
    const room = host(socket);

    if (room.phase !== 'finished') {
      fail('Finish this game first.');
    }

    resetToLobby(room);

    broadcast(room);

    return {};
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.code);

    if (!room) return;

    if (room.hostSocket === socket.id) {
      room.hostSocket = null;
      room.hostGoneAt = Date.now();
    }

    const p = room.players.find(p => p.socket === socket.id);

    if (p) {
      p.socket = null;
    }

    broadcast(room);
  });
});

// Allow ten minutes for a lost host to return.
// Also expire rooms after twelve hours.
setInterval(() => {
  for (const [code, room] of rooms) {
    const hostExpired =
      room.hostGoneAt &&
      Date.now() - room.hostGoneAt > 600000;

    const roomExpired =
      Date.now() - room.touched > 43200000;

    if (hostExpired || roomExpired) {
      if (room.revealTimer) clearInterval(room.revealTimer);

      const ids = [
        room.hostSocket,
        ...room.players.map(p => p.socket)
      ].filter(Boolean);

      ids.forEach(id => {
        const socket = io.sockets.sockets.get(id);

        if (socket) {
          socket.data = {};
        }

        io.to(id).emit(
          'closed',
          'Room expired. Create or join a new room.'
        );
      });

      rooms.delete(code);
    }
  }
}, 30000).unref();

server.listen(port, '0.0.0.0', () => {
  console.log(`Host: http://localhost:${port}/host`);

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (
        address.family === 'IPv4' &&
        !address.internal
      ) {
        console.log(
          `Phones on your Wi-Fi: http://${address.address}:${port}`
        );
      }
    }
  }
});
