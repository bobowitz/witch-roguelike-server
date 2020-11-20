let app = require('express')();
let http = require('http').createServer(app);
let io = require('socket.io')(http);
let bcrypt = require('bcrypt');

class PlayerLogin {
  constructor(username, password) {
    this.username = username;
    this.password = password;
  }
}

class Player {
  constructor(socket, username) {
    this.socket = socket;
    this.username = username;
    this.currentWorld = undefined;

    this.x = 0;
    this.y = 0;
    this.levelID = 0;
  }
}

class World {
  constructor() {
    this.invitedPlayers = [];
    this.players = {};
    this.join_queue = [];
    this.gameState = {
      seed: (Math.random() * 4294967296) >>> 0,
      randomState: (Math.random() * 4294967296) >>> 0,
      init_state: true
    };
  }

  invitePlayer = (username) => {
    if (this.invitedPlayers.filter(u => u === username).length === 0) { // don't add if already exists
      this.invitedPlayers.push(username);
    }
  }

  isInvited = (username) => {
    return this.invitedPlayers.filter(u => u === username).length > 0;
  }
}

player_logins = [];
worlds = {};
activePlayers = {}; // activePlayers[socket.id] = ActivePlayer

let get_new_player_id = () => {
  let id = 0;
  for (l of player_logins) {
    if (l.pid >= id) id = l.pid + 1;
  }
  return id;
};

let get_new_world_key = () => {
  let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let already_exists = true;
  let world_key = "";
  while (already_exists) {
    world_key = "";
    for (let i = 0; i < 6; i++) {
      world_key += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    if (!(world_key in worlds)) already_exists = false;
  }
  return world_key;
};

let get_world_codes = (username) => {
  let available_world_codes = [];
  for (k in worlds) {
    if (worlds[k].invitedPlayers.filter(p => p === username).length > 0) {
      available_world_codes.push(k);
    }
  }
  return available_world_codes;
}

io.on('connection', (socket) => {
  socket.emit('new connect');

  let list_active_users = () => {
    let names = [];
    for (let sid in activePlayers) {
      if (activePlayers[sid]) names.push(activePlayers[sid].username);
      else names.push('NULL');
    }
    console.log(names);
  }

  let on_successful_login = (username) => {
    activePlayers[socket.id] = new Player(socket, username);
    socket.emit('logged in');
    list_active_users();
  }

  let broadcast_to_world = (...args) => {
    if (activePlayers[socket.id]) {
      for (let sid in activePlayers) {
        if (activePlayers[sid].currentWorld === activePlayers[socket.id].currentWorld)
          activePlayers[sid].socket.emit(...args);
      }
    }
  }

  let broadcast_to_world_others = (...args) => { // doesn't broadcast to self
    if (activePlayers[socket.id]) {
      for (let sid in activePlayers) {
        if (sid !== socket.id && activePlayers[sid].currentWorld === activePlayers[socket.id].currentWorld)
          activePlayers[sid].socket.emit(...args);
      }
    }
  }

  socket.on('login', (username, password) => {
    let login = player_logins.filter(l => l.username === username);
    if (login[0]) {
      bcrypt.compare(password, login[0].password, (err, result) => {
        if (result) {
          if (activePlayers[socket.id])
            socket.emit('login already active');
          else
            on_successful_login(username);
        }
        else socket.emit('incorrect password');
      });
    } else {
      bcrypt.hash(password, 8, (err, hash) => {
        let player_login = new PlayerLogin(username, hash);
        player_logins.push(player_login);
        on_successful_login(player_login.username);
      });
    }
  });

  socket.on('get available worlds', () => {
    if (activePlayers[socket.id])
      socket.emit('world codes', get_world_codes(activePlayers[socket.id].username));
    else
      socket.emit('unrecognized session');
  });

  socket.on('join new world', () => {
    if (activePlayers[socket.id]) {
      let world = new World();
      world.invitePlayer(activePlayers[socket.id].username);
      activePlayers[socket.id].currentWorld = world;
      worlds[get_new_world_key()] = world;
      socket.emit('welcome', world.gameState);
      broadcast_to_world('chat message', activePlayers[socket.id].username + ' joined');
    }
    else
      socket.emit('unrecognized session');
  });

  socket.on('join world', world_code => {
    if (activePlayers[socket.id]) {
      let p = activePlayers[socket.id];
      p.currentWorld = undefined;
      if (world_code in worlds && worlds[world_code].isInvited(activePlayers[socket.id].username)) {
        let waiting_for_state_update = false;
        for (let sid in activePlayers) {
          if (activePlayers[sid].currentWorld === worlds[world_code]) {
            console.log('queueing...');
            activePlayers[sid].socket.emit('get state');
            worlds[world_code].join_queue.push(socket.id);
            waiting_for_state_update = true;
            break;
          }
        }
        if (!waiting_for_state_update) {
          console.log('joined with no queue');
          activePlayers[socket.id].currentWorld = worlds[world_code];
          socket.emit('welcome', worlds[world_code].gameState);
          broadcast_to_world_others('player joined', activePlayers[socket.id].username);
          broadcast_to_world('chat message', activePlayers[socket.id].username + ' joined');
        }
      }
    }
    else
      socket.emit('unrecognized session');
  });

  socket.on('leave world', () => {
    if (activePlayers[socket.id] && activePlayers[socket.id].currentWorld) {
      broadcast_to_world_others('player left', activePlayers[socket.id].username);
      broadcast_to_world_others('chat message', activePlayers[socket.id].username + " left");
      activePlayers[socket.id].currentWorld = null;
    } else
      socket.emit('unrecognized session');
  });

  socket.on('invite', username => {
    if (activePlayers[socket.id] && activePlayers[socket.id].currentWorld) {
      let chatMessage = "invited " + username;
      if (player_logins.filter(l => l.username === username).length > 0)
        activePlayers[socket.id].currentWorld.invitePlayer(username);
      else
        chatMessage = "user does not exist";
      broadcast_to_world('chat message', chatMessage);
    }
    else
      socket.emit('unrecognized session');
  });

  socket.on('chat message', message => {
    if (activePlayers[socket.id] && activePlayers[socket.id].currentWorld)
      broadcast_to_world('chat message', activePlayers[socket.id].username + ': ' + message);
    else
      socket.emit('unrecognized session');
  });

  socket.on('input', (tick_player_id, input) => {
    if (activePlayers[socket.id] && activePlayers[socket.id].currentWorld)
      broadcast_to_world('input', tick_player_id, input);
    else
      socket.emit('unrecognized session');
  });

  socket.on('game state', (state) => {
    if (activePlayers[socket.id] && activePlayers[socket.id].currentWorld) {
      activePlayers[socket.id].currentWorld.gameState = state;
      while (activePlayers[socket.id].currentWorld.join_queue.length > 0) {
        const sid = activePlayers[socket.id].currentWorld.join_queue.pop();
        console.log('transmitting new game state from ' + activePlayers[socket.id].username + ' to ' + activePlayers[sid].username);
        if (activePlayers[sid]) {
          activePlayers[sid].currentWorld = activePlayers[socket.id].currentWorld;
          activePlayers[sid].socket.emit('welcome', state);
          for (let other_sid in activePlayers) {
            if (other_sid !== sid && activePlayers[other_sid].currentWorld === activePlayers[sid].currentWorld)
              activePlayers[other_sid].socket.emit('player joined', activePlayers[sid].username);
          }
          broadcast_to_world('chat message', activePlayers[sid].username + ' joined');
        }
      }
    }
    else
      socket.emit('unrecognized session');
  });

  let logout = () => {
    if (activePlayers[socket.id] && activePlayers[socket.id].currentWorld) {
      broadcast_to_world_others('player left', activePlayers[socket.id].username);
      broadcast_to_world_others('chat message', activePlayers[socket.id].username + " left");
    }
    delete activePlayers[socket.id];
    list_active_users();
  };

  socket.on('logout', logout);
  socket.on('disconnect', logout);
});

let port = process.env.PORT || 3000;

http.listen(port, () => { console.log('listening on port ' + port); });