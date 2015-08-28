var debug = require('debug')('cubelets:cordova')
var util = require('util')
var Scanner = require('../scanner')
var Connection = require('../connection')
var Client = require('../client')
var bluetooth = cordova.require('com.modrobotics.bluetooth.index')

var BluetoothScanner = function () {
  Scanner.call(this)

  this._getDevices = function (callback) {
    var result = []
    bluetooth.getDevices(function (devices) {
      devices.forEach(function (device) {
        var name = device.name
        var deviceId = device.deviceId
        if (name.indexOf('Cubelet') === 0) {
          result.push({
            deviceId: deviceId,
            name: name
          })
        }
      })
      callback(result)
    })
  }

  this._compareDevice = function (device, otherDevice) {
    return device.deviceId == otherDevice.deviceId
  }
}

util.inherits(BluetoothScanner, Scanner)

var BluetoothConnection = function (device, opts) {
  Connection.call(this, device, opts)

  var stream = this
  var isOpen = false

  this._read = function (n) {
    // do nothing
  }

  this._write = function (data, enc, next) {
    var chunkSize = 60
    writeChunk(0)
    function writeChunk(i) {
      var start = i * chunkSize
      var end = start + chunkSize
      var chunk = data.slice(start, end)
      if (chunk.length > 0) {
        write(chunk, function (err) {
          if (err) {
            next(err)
          } else {
            writeChunk(i + 1)
          }
        })
      } else {
        next()
      }
    }
    function write(chunk, callback) {
      if (isOpen) {
        debug('<<', chunk)
        bluetooth.send(device.deviceId, toArrayBuffer(chunk), callback)
      } else {
        callback(new Error('disconnected'))
      }
    }
  }

  function onReceive(receiveInfo) {
    if (receiveInfo.deviceId === device.deviceId) {
      var chunk = toBuffer(receiveInfo.data)
      debug('>>', chunk)
      stream.push(chunk)
    }
  }

  function onReceiveError(errorInfo) {
    if (errorInfo.deviceId === device.deviceId) {
      isOpen = false
      stream.emit('error', new Error(errorInfo.errorMessage))
      stream.close()
    }
  }

  this._open = function (callback) {
    if (isOpen) {
      if (callback) {
        callback(null)
      }
    } else {
      bluetooth.connect(device.deviceId, function () {
        isOpen = true
        addListeners()
        if (callback) {
          callback(null)
        }
      })
    }
  }

  this._close = function (callback) {
    if (!isOpen) {
      if (callback) {
        callback(null)
      }
    } else {
      removeListeners()
      if (isOpen) {
        isOpen = false
        bluetooth.disconnect(device.deviceId, function () {
          if (callback) {
            callback(null)
          }
        })
      } else {
        if (callback) {
          callback(null)
        }
      }
    }
  }

  function toBuffer(ab) {
    var len = ab.byteLength
    var view = new Uint8Array(ab)
    var buf = new Buffer(len)
    for (var i = 0; i < len; ++i) {
      buf[i] = view[i]
    }
    return buf
  }

  function toArrayBuffer(buf) {
    var ab = new ArrayBuffer(buf.length)
    var view = new Uint8Array(ab)
    for (var i = 0; i < buf.length; ++i) {
      view[i] = buf[i]
    }
    return ab
  }

  function addListeners() {
    bluetooth.onReceive.addListener(onReceive)
    bluetooth.onReceiveError.addListener(onReceiveError)
  }

  function removeListeners() {
    bluetooth.onReceive.removeListener(onReceive)
    bluetooth.onReceiveError.removeListener(onReceiveError)
  }
}

util.inherits(BluetoothConnection, Connection)

module.exports = Client(new BluetoothScanner(), BluetoothConnection)
