const debug = require('debug');
const util = require('util');

/**
 * generate consistent prefix for log messages
 * with epress session id and socket session id
 * @param {object} socket Socket information
 */
function prefix(socket) {
  return `(${socket.request.sessionID}/${socket.id})`;
}

function webssh2debug(socket, msg) {
  debug('WebSSH2')(`${prefix(socket)} ${msg}`);
}



module.exports = {webssh2debug };
