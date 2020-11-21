const app = require('express')();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const bcrypt = require('bcrypt');
const { Client } = require('pg');
const { Mutex } = require('async-mutex');

class PlayerLogin {
  constructor(username, password) {
    this.username = username;
    this.password = password;
  }
}

class ActivePlayer {
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
    this.join_queue = [];
    this.gameState = {
      seed: (Math.random() * 4294967296) >>> 0,
      randomState: (Math.random() * 4294967296) >>> 0,
      init_state: true
    };
  }

  copyFrom = (otherWorld) => {
    this.invitedPlayers = otherWorld.invitedPlayers;
    this.join_queue = otherWorld.join_queue;
    this.gameState = otherWorld.gameState;
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

// server state
let player_logins = [];
let worlds = {};
let activePlayers = {}; // activePlayers[socket.id] = ActivePlayer
let lastSavedTime = 0;
let serverStartTime = new Date();
const m = new Mutex();

// status page
app.get('/status', (req, res) => {
  let s = 'server started at ' + serverStartTime.toLocaleString();
  let a = 'active players: ' + Object.values(activePlayers).map(ap => ap.username).toString();
  let l = 'registered players: ' + player_logins.map(l => l.username).toString();
  let w = 'worlds:<br>' + Object.keys(worlds).map(k => '    ' + k + ' ' + worlds[k].invitedPlayers.toString());
  let d = lastSavedTime === 0 ? 'have not written to db yet' : ('db written on ' + lastSavedTime.toLocaleString());
  res.send(`<pre><code>${s}<br>${a}<br>${l}<br>${w}<br>${d}</code></pre>`);
});

// postgres
const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

db.connect().catch(e => console.log('Error in db.connect: ', e));

const createTableQuery = `
CREATE TABLE IF NOT EXISTS jsondata (
  id TEXT NOT NULL PRIMARY KEY,
  data TEXT NOT NULL
)
`

db.query(createTableQuery).catch(e => console.log('Error in db.query(createTableQuery): ', e));

async function db_get(id) {
  const result = await db.query('SELECT data FROM jsondata WHERE id=$1', [id]);
  const [row] = result.rows;
  return row ? row.data : null;
}

async function db_set(id, value) {
  await db.query('INSERT INTO jsondata (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data;', [id, value]);
}

// load server state from db
m.acquire().then(release => {
  db_get('logins').then(db_logins => {
    if (db_logins) {
      player_logins = JSON.parse(db_logins);
      console.log('loaded existing logins from db:', player_logins.map(l => l.username));
    }
  }).catch(e => console.log('<WRS> error getting logins:', e));
  db_get('worlds').then(db_worlds => {
    if (db_worlds) {
      let otherWorlds = JSON.parse(db_worlds);
      worlds = {};
      for (const k in otherWorlds) {
        let w = new World();
        w.copyFrom(otherWorlds[k]);
        worlds[k] = w;
      }
      console.log('loaded existing worlds from db', Object.keys(worlds));
    }
    release();
  }).catch(e => console.log('<WRS> error getting worlds:', e));
});

let save_server_state = () => {
  console.log('saving...');
  m.acquire().then(release => {
    db_set('logins', JSON.stringify(player_logins)).catch(e => console.log('<WRS> error setting logins:', e));
    db_set('worlds', JSON.stringify(worlds)).catch(e => console.log('<WRS> error setting worlds:', e));
    release();
    lastSavedTime = new Date();
    console.log('saved');
  });
}
setTimeout(save_server_state, 60000);

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
    console.log('active: ', names);
  }

  let on_successful_login = (username) => {
    activePlayers[socket.id] = new ActivePlayer(socket, username);
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
        m.acquire().then(release => {
          player_logins.push(player_login);
          release();
        });
        save_server_state();
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
      m.acquire().then(release => {
        worlds[get_new_world_key()] = world;
        release();
      });
      save_server_state();
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
            activePlayers[sid].socket.emit('get state');
            worlds[world_code].join_queue.push(socket.id);
            waiting_for_state_update = true;
            break;
          }
        }
        if (!waiting_for_state_update) {
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
      m.acquire().then(release => {
        activePlayers[socket.id].currentWorld.gameState = state;
        release();
      });
      save_server_state();
      while (activePlayers[socket.id].currentWorld.join_queue.length > 0) {
        const sid = activePlayers[socket.id].currentWorld.join_queue.pop();
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