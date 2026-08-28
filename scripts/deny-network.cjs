const net = require("node:net");

net.Socket.prototype.connect = function denyNetwork() {
  throw new Error("network access is disabled for offline package acceptance");
};
