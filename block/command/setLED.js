var util = require('util')
var Message = require('../message')
var Encoder = require('../../encoder')

var SetLEDCommand = function (id, enable) {
  Message.call(this, id)
  this.enable = enable
}

util.inherits(SetLEDCommand, Message)

SetLEDCommand.prototype.encodeBody = function () {
  return new Buffer([ this.enable ? 1 : 0 ])
}

module.exports = SetLEDCommand
