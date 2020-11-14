let app = require('express')();
let http = require('http').createServer(app);
let io = require('socket.io')(http);

player_ids = [];
seed = "" + Math.random();
console.log(seed);

let get_new_player_id = () => {
  let id = 0;
  for (i of player_ids) {
    if (i >= id) id = i + 1;
  }
  player_ids.push(id);
  return id;
};

io.on('connection', (socket) => {
  console.log('connection');

  let pid = get_new_player_id();
  socket.emit('welcome', seed, pid);
  console.log('player_ids ', player_ids);

  socket.broadcast.emit('player connected', pid);

  socket.on('tick', (tick_player_id, dir) => {
    socket.broadcast.emit('tick', tick_player_id, dir);
  });

  socket.on('disconnect', () => {
    player_ids = player_ids.filter(x => x !== pid);
    socket.broadcast.emit('player disconnected', pid);
    console.log('disconnect');
    console.log('player_ids ', player_ids);
  });
});

http.listen(3000, () => { console.log('listening on port 3000'); });