let app = require('express')();
let http = require('http').createServer(app);
let io = require('socket.io')(http);

io.on('connection', (socket) => {
  console.log('connection');
  socket.broadcast.emit('message', 'somebody connected');
  socket.on('disconnect', () => {
    console.log('disconnect');
  });
});

http.listen(3000, () => { console.log('listening on port 3000'); });