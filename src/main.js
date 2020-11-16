let app = require('express')();
let http = require('http').createServer(app);
let io = require('socket.io')(http);

app.get('/', (req, res) => {
  res.send('<h1>Hello world</h1>');
});

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
  let pid = get_new_player_id();
  socket.emit('welcome', seed, pid);

  console.log('connection', player_ids);

  socket.broadcast.emit('player connected', pid);
  io.emit('chat message', 'player ' + pid + ' connected');

  socket.on('chat message', message => {
    io.emit('chat message', message);
  });

  socket.on('input', (tick_player_id, input) => {
    io.emit('input', tick_player_id, input);
  });

  socket.on('disconnect', () => {
    player_ids = player_ids.filter(x => x !== pid);
    socket.broadcast.emit('player disconnected', pid);
    io.emit('chat message', 'player ' + pid + ' disconnected');
    console.log('disconnect', player_ids);
  });
});

let port = process.env.PORT || 3000;

http.listen(port, () => { console.log('listening on port ' + port); });