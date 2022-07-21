/* eslint-disable complexity */
/* eslint no-unused-expressions: ["error", { "allowShortCircuit": true, "allowTernary": true }],
   no-console: ["error", { allow: ["warn", "error"] }] */
/* jshint esversion: 6, asi: true, node: true */
// socket.js

// private
const debug = require('debug');
const SSH = require('ssh2').Client;
const CIDRMatcher = require('cidr-matcher');
const validator = require('validator');
const dnsPromises = require('dns').promises;
const util = require('util');

/**
 * parse conn errors
 * @param {object} socket Socket object
 * @param {object} err    Error object
 */
function connError(socket, err) {
  let msg = util.inspect(err);
  const { session } = socket.request;
  if (err?.level === 'client-authentication') {
    msg = `Authentication failure user=${session.username} from=${socket.handshake.address}`;
    socket.emit('allowreauth', session.ssh.allowreauth);
    socket.emit('reauth');
  }
  if (err?.code === 'ENOTFOUND') {
    msg = `Host not found: ${err.hostname}`;
  }
  if (err?.level === 'client-timeout') {
    msg = `Connection Timeout: ${session.ssh.host}`;
  }
  
}

/**
 * check ssh host is in allowed subnet
 * @param {object} socket Socket information
 */
async function checkSubnet(socket) {
  let ipaddress = socket.request.session.ssh.host;
  if (!validator.isIP(`${ipaddress}`)) {
    try {
      const result = await dnsPromises.lookup(socket.request.session.ssh.host);
      ipaddress = result.address;
    } catch (err) {
      socket.emit('ssherror', '404 HOST IP NOT FOUND');
      socket.disconnect(true);
      return;
    }
  }

  const matcher = new CIDRMatcher(socket.request.session.ssh.allowedSubnets);
  if (!matcher.contains(ipaddress)) {
    socket.emit('ssherror', '401 UNAUTHORIZED');
    socket.disconnect(true);
  }
}

// public
module.exports = function appSocket(socket) {
  let login = false;

  socket.once('disconnecting', (reason) => {
    
    if (login === true) {
      login = false;
    }
  });

  async function setupConnection() {
    // if websocket connection arrives without an express session, kill it
    if (!socket.request.session) {
      socket.emit('401 UNAUTHORIZED');
      socket.disconnect(true);
      return;
    }

    // If configured, check that requsted host is in a permitted subnet
    if (socket.request.session?.ssh?.allowedSubnets?.length > 0) {
      checkSubnet(socket);
    }

    const conn = new SSH();

    conn.on('banner', (data) => {
      // need to convert to cr/lf for proper formatting
      socket.emit('data', data.replace(/\r?\n/g, '\r\n').toString('utf-8'));
    });

    conn.on('ready', () => {
      login = true;
      socket.emit('menu');
      socket.emit('allowreauth', socket.request.session.ssh.allowreauth);
      socket.emit('setTerminalOpts', socket.request.session.ssh.terminal);
      socket.emit('title', `ssh://${socket.request.session.ssh.host}`);
      if (socket.request.session.ssh.header.background)
        socket.emit('headerBackground', socket.request.session.ssh.header.background);
      if (socket.request.session.ssh.header.name)
        socket.emit('header', socket.request.session.ssh.header.name);
      socket.emit(
        'footer',
        `ssh://${socket.request.session.username}@${socket.request.session.ssh.host}:${socket.request.session.ssh.port}`
      );
      socket.emit('status', 'SSH CONNECTION ESTABLISHED');
      socket.emit('statusBackground', 'green');
      socket.emit('allowreplay', socket.request.session.ssh.allowreplay);
      const { term, cols, rows } = socket.request.session.ssh;
      conn.shell({ term, cols, rows }, (err, stream) => {
        if (err) {
          conn.end();
          socket.disconnect(true);
          return;
        }
        socket.once('disconnect', (reason) => {
          conn.end();
          socket.request.session.destroy();
        });
        socket.on('error', (errMsg) => {
          conn.end();
          socket.disconnect(true);
        });
        socket.on('control', (controlData) => {
          if (controlData === 'replayCredentials' && socket.request.session.ssh.allowreplay) {
            stream.write(`${socket.request.session.userpassword}\n`);
          }
          if (controlData === 'reauth' && socket.request.session.username && login === true) {
            login = false;
            conn.end();
            socket.disconnect(true);
          }
        });
        socket.on('resize', (data) => {
          stream.setWindow(data.rows, data.cols);
        });
        socket.on('data', (data) => {
          stream.write(data);
        });
        stream.on('data', (data) => {
          socket.emit('data', data.toString('utf-8'));
        });
        stream.on('close', (code, signal) => {
          if (socket.request.session?.username && login === true) {
            login = false;
          }
          if (code !== 0 && typeof code !== 'undefined')
          socket.disconnect(true);
          conn.end();
        });
        stream.stderr.on('data', (data) => {
          console.error(`STDERR: ${data}`);
        });
      });
    });

    conn.on('end', (err) => {
      socket.disconnect(true);
    });
    conn.on('close', (err) => {
      if (err) 
      socket.disconnect(true);
    });
    conn.on('error', (err) => connError(socket, err));

    conn.on('keyboard-interactive', (_name, _instructions, _instructionsLang, _prompts, finish) => {
      finish([socket.request.session.userpassword]);
    });
    if (
      socket.request.session.username &&
      (socket.request.session.userpassword || socket.request.session.privatekey) &&
      socket.request.session.ssh
    ) {
      // console.log('hostkeys: ' + hostkeys[0].[0])
      const { ssh } = socket.request.session;
      ssh.username = socket.request.session.username;
      ssh.password = socket.request.session.userpassword;
      ssh.tryKeyboard = true;
      ssh.debug = debug('ssh2');
      conn.connect(ssh);
    } else {
      socket.emit('ssherror', 'WEBSOCKET ERROR - Refresh the browser and try again');
      socket.request.session.destroy();
      socket.disconnect(true);
    }
  }
  setupConnection();
};
