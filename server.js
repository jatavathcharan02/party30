const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MAX_PLAYERS = 30;
const rooms = new Map();

const TRUTHS = [
  "What is the most embarrassing thing you've ever done in public?",
  "Who in this room would you trust with your deepest secret?",
  "What is one habit you have that nobody knows about?",
  "Have you ever lied to get out of plans with friends? What was the excuse?",
  "What is the weirdest food combination you secretly enjoy?",
  "What was your biggest childhood fear?",
  "If you could swap lives with anyone in this room for a day, who would it be?",
  "What is the last thing you searched on your phone?",
  "Have you ever blamed someone else for something you broke or messed up?",
  "What is a talent you pretend to have or wish you had?"
];

const DARES = [
  "Speak in a dramatic movie-trailer voice until your next turn.",
  "Do 10 jumping jacks right now while counting out loud.",
  "Show the group the last photo in your camera roll (nothing private!).",
  "Talk without using the letter 'E' for the next 30 seconds.",
  "Do your best impression of another player in the room.",
  "Hold a funny pose for 20 seconds without laughing.",
  "Sing the chorus of your favorite song out loud.",
  "Balance on one foot for 30 seconds.",
  "Let the group pick a weird word you must say in every sentence for 2 minutes.",
  "Send a funny emoji to the 3rd person in your chat list."
];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    maxPlayers: MAX_PLAYERS,
    state: room.state,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      hasChosen: Boolean(p.choice),
      choice: room.rps.phase === 'choosing' ? null : p.choice
    })),
    tod: {
      currentPlayerId: room.tod.currentPlayerId,
      choiceType: room.tod.choiceType,
      prompt: room.tod.prompt
    },
    rps: {
      round: room.rps.round,
      phase: room.rps.phase,
      timeLeft: room.rps.timeLeft,
      botChoice: room.rps.botChoice,
      winnerName: room.rps.winnerName,
      message: room.rps.message
    }
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room_update', serializeRoom(room));
}

function clearRpsTimer(room) {
  if (room.rps.timer) {
    clearInterval(room.rps.timer);
    room.rps.timer = null;
  }
}

function pickRandomTodPlayer(room, excludeId = null) {
  const pool =
    room.players.length > 1 && excludeId
      ? room.players.filter((p) => p.id !== excludeId)
      : room.players;
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)].id;
}

function beats(playerChoice, botChoice) {
  return (
    (playerChoice === 'rock' && botChoice === 'scissors') ||
    (playerChoice === 'paper' && botChoice === 'rock') ||
    (playerChoice === 'scissors' && botChoice === 'paper')
  );
}

function startRpsTimer(room) {
  clearRpsTimer(room);
  room.rps.timeLeft = 15;

  room.rps.timer = setInterval(() => {
    room.rps.timeLeft -= 1;
    if (room.rps.timeLeft <= 0) {
      clearRpsTimer(room);
      resolveRpsRound(room);
    } else {
      broadcastRoom(room);
    }
  }, 1000);
}

function resolveRpsRound(room) {
  clearRpsTimer(room);
  const options = ['rock', 'paper', 'scissors'];
  const botChoice = options[Math.floor(Math.random() * options.length)];
  room.rps.botChoice = botChoice;

  const alivePlayers = room.players.filter((p) => p.alive);
  const survivors = [];
  const eliminated = [];

  for (const p of alivePlayers) {
    if (!p.choice) {
      eliminated.push(p);
    } else if (p.choice === botChoice || beats(p.choice, botChoice)) {
      survivors.push(p);
    } else {
      eliminated.push(p);
    }
  }

  if (survivors.length === 0 && alivePlayers.length > 0) {
    room.rps.phase = 'result';
    room.rps.message = 'Nobody survived that round! Tie-breaker: everyone stays in!';
  } else {
    for (const p of eliminated) {
      p.alive = false;
    }

    if (alivePlayers.length > 1 && survivors.length === 1) {
      room.rps.phase = 'gameover';
      room.rps.winnerName = survivors[0].name;
      room.rps.message = `${survivors[0].name} is the last player standing!`;
    } else {
      room.rps.phase = 'result';
      room.rps.message = `${survivors.length} player(s) survived Round ${room.rps.round}!`;
    }
  }

  broadcastRoom(room);
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ name }) => {
    const cleanName = (name || '').trim().slice(0, 18);
    if (!cleanName) return socket.emit('error_msg', 'Please enter your name.');

    const code = generateRoomCode();
    const room = {
      code,
      hostId: socket.id,
      state: 'lobby',
      players: [{ id: socket.id, name: cleanName, alive: true, choice: null }],
      tod: { currentPlayerId: null, choiceType: null, prompt: null },
      rps: {
        round: 1,
        phase: 'choosing',
        timeLeft: 15,
        timer: null,
        botChoice: null,
        winnerName: null,
        message: ''
      }
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    broadcastRoom(room);
  });

  socket.on('join_room', ({ name, code }) => {
    const cleanName = (name || '').trim().slice(0, 18);
    const cleanCode = (code || '').trim().toUpperCase();

    if (!cleanName) return socket.emit('error_msg', 'Please enter your name.');
    if (!cleanCode) return socket.emit('error_msg', 'Please enter a room code.');

    const room = rooms.get(cleanCode);
    if (!room) return socket.emit('error_msg', 'Room not found. Check the code.');
    if (room.players.length >= MAX_PLAYERS) {
      return socket.emit('error_msg', 'Room is full (30/30 players).');
    }

    const duplicate = room.players.some(
      (p) => p.name.toLowerCase() === cleanName.toLowerCase()
    );
    const finalName = duplicate ? `${cleanName}_${room.players.length + 1}` : cleanName;

    room.players.push({
      id: socket.id,
      name: finalName,
      alive: room.state === 'lobby',
      choice: null
    });

    socket.join(cleanCode);
    socket.data.roomCode = cleanCode;
    broadcastRoom(room);
  });

  socket.on('start_game', ({ game }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;

    clearRpsTimer(room);

    if (game === 'tod') {
      room.state = 'tod';
      room.tod = {
        currentPlayerId: pickRandomTodPlayer(room),
        choiceType: null,
        prompt: null
      };
    } else if (game === 'rps') {
      room.state = 'rps';
      room.players.forEach((p) => {
        p.alive = true;
        p.choice = null;
      });
      room.rps = {
        round: 1,
        phase: 'choosing',
        timeLeft: 15,
        timer: null,
        botChoice: null,
        winnerName: null,
        message: ''
      };
      startRpsTimer(room);
    }

    broadcastRoom(room);
  });

  socket.on('back_to_lobby', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;

    clearRpsTimer(room);
    room.state = 'lobby';
    room.players.forEach((p) => {
      p.alive = true;
      p.choice = null;
    });
    broadcastRoom(room);
  });

  socket.on('tod_choose', ({ type }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'tod') return;
    if (room.tod.currentPlayerId !== socket.id || room.tod.prompt) return;

    const list = type === 'truth' ? TRUTHS : DARES;
    room.tod.choiceType = type === 'truth' ? 'TRUTH' : 'DARE';
    room.tod.prompt = list[Math.floor(Math.random() * list.length)];
    broadcastRoom(room);
  });

  socket.on('tod_next', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'tod') return;
    if (room.hostId !== socket.id && room.tod.currentPlayerId !== socket.id) return;

    room.tod.currentPlayerId = pickRandomTodPlayer(room, room.tod.currentPlayerId);
    room.tod.choiceType = null;
    room.tod.prompt = null;
    broadcastRoom(room);
  });

  socket.on('rps_pick', ({ choice }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'rps' || room.rps.phase !== 'choosing') return;
    if (!['rock', 'paper', 'scissors'].includes(choice)) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || !player.alive) return;

    player.choice = choice;

    const alivePlayers = room.players.filter((p) => p.alive);
    if (alivePlayers.every((p) => p.choice !== null)) {
      resolveRpsRound(room);
    } else {
      broadcastRoom(room);
    }
  });

  socket.on('rps_next_round', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'rps' || room.hostId !== socket.id) return;

    room.rps.round += 1;
    room.rps.phase = 'choosing';
    room.rps.botChoice = null;
    room.rps.message = '';
    room.players.forEach((p) => {
      p.choice = null;
    });
    startRpsTimer(room);
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    room.players = room.players.filter((p) => p.id !== socket.id);

    if (room.players.length === 0) {
      clearRpsTimer(room);
      rooms.delete(code);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
    }

    if (room.state === 'tod' && room.tod.currentPlayerId === socket.id) {
      room.tod.currentPlayerId = pickRandomTodPlayer(room);
      room.tod.choiceType = null;
      room.tod.prompt = null;
    }

    if (room.state === 'rps' && room.rps.phase === 'choosing') {
      const alivePlayers = room.players.filter((p) => p.alive);
      if (alivePlayers.length > 0 && alivePlayers.every((p) => p.choice !== null)) {
        resolveRpsRound(room);
        return;
      }
    }

    broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Party30 app running on http://localhost:${PORT}`);
});
