var debug = require('debug')('cubelets:upgrade')
var assert = require('assert')
var util = require('util')
var events = require('events')
var async = require('async')
var ClassicProtocol = require('../protocol/classic')
var ClassicProgram = ClassicProtocol.Program
var ClassicFlash = ClassicProtocol.Flash
var ImagoProtocol = require('../protocol/imago')
var ImagoProgram = ImagoProtocol.Program
var ImagoFlash = ImagoProtocol.Flash
var BootstrapProtocol = require('../protocol/bootstrap')
var Block = require('../block')
var BlockTypes = require('../blockTypes')
var MCUTypes = require('../mcuTypes')
var InfoService = require('../services/info')
var HexFiles = require('./hexFiles')
var emptyFunction = function () {}
var __ = require('underscore')

var FirmwareTypes = {
  CLASSIC: 0,
  IMAGO: 1,
  BOOTSTRAP: 2
}

var Upgrade = function (client) {
  var self = this
  events.EventEmitter.call(this)

  var running = false
  var finished = false
  var hostBlock = null
  var targetFaces = {}
  var pendingBlocks = []
  var completedBlocks = []
  var targetBlock = null

  this.detectIfNeeded = function (callback) {
    callback = callback || emptyFunction
    detectFirmwareType(function (err, firmwareType) {
      if (err) {
        callback(err)
      } else {
        callback(null, (FirmwareTypes.IMAGO !== firmwareType), firmwareType)
      }
    })
  }

  function detectFirmwareType(callback) {
    // Switch to the classic protocol
    client.setProtocol(ClassicProtocol)
    // Send a keep alive request to test how the cubelet responds
    client.sendRequest(new ClassicProtocol.messages.KeepAliveRequest(), function (err, response) {
      if (err) {
        // The imago protocol will fail to respond.
        client.setProtocol(ImagoProtocol)
        callback(null, FirmwareTypes.IMAGO)
      } else if (response.payload.length > 0) {
        // The bootstrap protocol will differentiate itself by
        // sending an extra byte in the response.
        client.setProtocol(BootstrapProtocol)
        callback(null, FirmwareTypes.BOOTSTRAP)
      } else {
        // Otherwise, the cubelet has classic firmware.
        callback(null, FirmwareTypes.CLASSIC)
      }
    }, 500)
  }

  this.start = function (callback) {
    callback = callback || emptyFunction
    if (running) {
      callback(new Error('Upgrade already started.'))
    } else {
      running = true
      finished = false
      self.emit('start')
      detectFirmwareType(function (err, firmwareType) {
        if (err) {
          callback(err)
          self.emit('error', err)
        } else if (FirmwareTypes.CLASSIC === firmwareType) {
          async.series([
            jumpToClassic,
            discoverHostBlock,
            flashBootstrapToHostBlock,
            startBlockUpgrades,
            jumpToDiscovery,
            jumpToClassic,
            flashUpgradeToHostBlock
          ], onFinish)
        } else if (FirmwareTypes.BOOTSTRAP === firmwareType) {
          async.series([
            startBlockUpgrades,
            jumpToDiscovery,
            jumpToClassic,
            discoverHostBlock,
            flashUpgradeToHostBlock
          ], onFinish)
        } else {
          callback(new Error('Upgrade started with invalid firmware type.'))
        }
      })
      function onFinish(err) {
        finished = true
        running = false
        callback(err)
        if (err) {
          self.emit('error', err)
        } else {
          self.emit('finish')
        }
      }
    }
  }

  this.finish = function () {
    if (running) {
      finished = true
    }
  }

  function discoverHostBlock(callback) {
    debug('discoverHostBlock')
    assert.equal(client.getProtocol(), ClassicProtocol, 'Must be in OS3 mode.')
    var req = new ClassicProtocol.messages.GetNeighborBlocksRequest()
    client.sendRequest(req, function (err, res) {
      if (err) {
        callback(err)
      } else {
        var originBlockId = res.originBlockId
        if (originBlockId > 0) {
          hostBlock = new Block(originBlockId, 0, BlockTypes.BLUETOOTH)
          hostBlock._mcuType = MCUTypes.AVR
          callback(null)
        } else {
          callback(new Error('Host block not found.'))
        }
      }
    })
  }

  function flashBootstrapToHostBlock(callback) {
    debug('flashBootstrapToHostBlock')
    assert.equal(client.getProtocol(), ClassicProtocol, 'Must be in OS3 mode.')
    var hex = HexFiles['bluetooth']['bootstrap']
    var program = new ClassicProgram(hex)
    if (program.valid) {
      self.emit('flashBootstrapToHostBlock', hostBlock)
      var flash = new ClassicFlash(client, {
        skipSafeCheck: true
      })
      flash.programToBlock(program, hostBlock, function (err) {
        flash.removeListener('progress', onProgress)
        if (err) {
          callback(err)
        } else {
          client.setProtocol(BootstrapProtocol)
          async.detect([
            detectSkipReset,
            detectReset
          ], function (detector, callback) {
            detector(callback)
          }, function (result) {
            if (result) {
              callback(null)
            } else {
              callback(new Error('Block failed to reset after boostrap.'))
            }
          })
        }
      })
      flash.on('progress', onProgress)
      function onProgress(e) {
        self.emit('progress', e)
      }
    } else {
      callback(new Error('Program invalid.'))
    }
  }

  function detectSkipReset(callback) {
    client.on('event', onSkipDisconnectEvent)
    function onSkipDisconnectEvent(e) {
      if (e instanceof BootstrapProtocol.messages.SkipDisconnectEvent) {
        client.removeListener('event', onSkipDisconnectEvent)
        callback(true)
      }
    }
    setTimeout(function () {
      client.removeListener('event', onSkipDisconnectEvent)
      callback(false)
    }, 5000)
  }

  function detectReset(callback) {
    async.series([
      retry({ times: 20, interval: 5000 }, waitForDisconnect),
      retry({ times: 20, interval: 5000 }, waitForReconnect)
    ], function (err) {
      callback(err ? false : true)
    })
  }

  function waitForDisconnect(callback) {
    var timer = setTimeout(function () {
      client.removeListener('disconnect', onDisconnect)
      client.removeListener('event', onDisconnectFailedEvent)
      callback(new Error('Failed to disconnect.'))
    }, 5000)
    client.on('disconnect', onDisconnect)
    function onDisconnect() {
      client.removeListener('disconnect', onDisconnect)
      client.removeListener('event', onDisconnectFailedEvent)
      if (timer) {
        clearTimeout(timer)
        callback(null)
      } else {
        callback(new Error('Disconnected before flashing complete.'))
      }
    }
    client.on('event', onDisconnectFailedEvent)
    function onDisconnectFailedEvent(e) {
      if (e instanceof BootstrapProtocol.messages.DisconnectFailedEvent) {
        self.emit('needToDisconnect')
      }
    }
  }

  function waitForReconnect(callback) {
    var timer = setTimeout(function () {
      client.removeListener('connect', onConnect)
      callback(new Error('Failed to reconnect.'))
    }, 5000)
    client.on('connect', onConnect)
    function onConnect() {
      client.removeListener('connect', onConnect)
      if (timer) {
        clearTimeout(timer)
        callback(null)
      }
    }
    self.emit('needToConnect')
  }

  this.getPendingBlocks = function () {
    return pendingBlocks
  }

  function enqueuePendingBlock(block) {
    debug('enqueuePendingBlock')
    if (!findPendingBlockById(block.getBlockId())) {
      pendingBlocks.unshift(block)
      self.emit('changePendingBlocks', pendingBlocks)
      return true
    } else {
      return false
    }
  }

  function dequeuePendingBlock() {
    debug('dequeuePendingBlock')
    var index = __(pendingBlocks).findIndex(function (block) {
      return block.getBlockType() !== BlockTypes.UNKNOWN
    })
    if (index > -1) {
      var nextBlock = pendingBlocks[index]
      pendingBlocks.splice(index, 1)
      self.emit('changePendingBlocks', pendingBlocks)
      return nextBlock
    }
  }

  this.getTargetBlock = function () {
    return targetBlock
  }

  function setTargetBlock(block) {
    debug('setTargetBlock')
    targetBlock = block
    self.emit('changeTargetBlock', targetBlock)
  }

  this.getCompletedBlocks = function () {
    return completedBlocks
  }

  function enqueueCompletedBlock(block) {
    debug('enqueueCompletedBlock')
    if (!findCompletedBlockById(block.getBlockId())) {
      completedBlocks.unshift(block)
      self.emit('completeTargetBlock', block)
      self.emit('changeCompletedBlocks', completedBlocks)
      return true
    } else {
      return false
    }
  }

  function startBlockUpgrades(callback) {
    debug('startBlockUpgrades')
    self.emit('startBlockUpgrades')
    async.until(function () {
      return finished
    }, function (next) {
      async.series([
        jumpToDiscovery,
        discoverTargetFaces,
        wait(2500)
      ], next)
    }, callback)
  }

  function jumpToClassic(callback) {
    debug('jumpToClassic')
    var protocol = client.getProtocol()
    if (ClassicProtocol === protocol) {
      callback(null)
    } else if (BootstrapProtocol === protocol) {
      var req = new BootstrapProtocol.messages.SetBootstrapModeRequest(0)
      client.sendRequest(req, function (err, res) {
        if (err) {
          callback(err)
        } else if (res.mode !== 0) {
          callback(new Error('Failed to jump to OS3 mode.'))
        } else {
          client.setProtocol(ClassicProtocol)
          setTimeout(function () {
            callback(null)
          }, 500)
        }
      })
    } else {
      callback(new Error('Must not jump to OS3 mode from OS4 mode.'))
    }
  }

  function jumpToImago(callback) {
    debug('jumpToImago')
    var protocol = client.getProtocol()
    if (ImagoProtocol === protocol) {
      callback(null)
    } else if (BootstrapProtocol === protocol) {
      var req = new BootstrapProtocol.messages.SetBootstrapModeRequest(1)
      client.sendRequest(req, function (err, res) {
        if (err) {
          callback(err)
        } else if (res.mode !== 1) {
          callback(new Error('Failed to jump to OS4 mode.'))
        } else {
          client.setProtocol(ImagoProtocol)
          setTimeout(function () {
            callback(null)
          }, 500)
        }
      })
    } else {
      callback(new Error('Must not jump to OS4 mode from OS3 mode.'))
    }
  }

  function jumpToDiscovery(callback) {
    debug('jumpToDiscovery')
    var protocol = client.getProtocol()
    if (BootstrapProtocol === protocol) {
      callback(null)
    } else {
      var ResetCommand = protocol.messages.ResetCommand
      client.sendCommand(new ResetCommand())
      client.setProtocol(BootstrapProtocol)
      setTimeout(function () {
        callback(null)
      }, 500)
    }
  }

  function discoverTargetFaces(callback) {
    debug('discoverTargetFaces')
    assert.equal(client.getProtocol(), BootstrapProtocol, 'Must be in discovery mode.')
    targetFaces = {}
    client.on('event', onBlockFoundEvent)
    function onBlockFoundEvent(e) {
      if (e instanceof BootstrapProtocol.messages.BlockFoundEvent) {
        var faceIndex = e.faceIndex
        var firmwareType = e.firmwareType
        targetFaces[faceIndex] = {
          faceIndex: faceIndex,
          firmwareType: firmwareType,
          timestamp: __.now()
        }
      }
    }
    pendingBlocks = []
    setTimeout(function () {
      client.removeListener('event', onBlockFoundEvent)
      debug('faces', targetFaces)
      var classicFaces = __(targetFaces).where({ firmwareType: 0 })
      var imagoFaces = __(targetFaces).where({ firmwareType: 1 })
      if (classicFaces.length > 0) {
        debug('has os3 faces')
        async.series([
          jumpToClassic,
          wait(1000),
          enqueuePendingClassicBlocks,
          fetchUnknownPendingBlockTypes,
          upgradeNextPendingClassicBlock
        ], callback)
      } else if (imagoFaces.length > 0) {
        debug('has os4 faces only')
        async.series([
          jumpToImago,
          wait(1000),
          enqueuePendingImagoBlocks,
          fetchUnknownPendingBlockTypes,
          upgradeNextPendingImagoBlock
        ], callback)
      } else {
        debug('no faces')
        callback(null)
      }
    }, 2500)
  }

  function enqueuePendingClassicBlocks(callback) {
    debug('enqueuePendingClassicBlocks')
    assert.equal(client.getProtocol(), ClassicProtocol, 'Must be in OS3 mode.')
    var req = new ClassicProtocol.messages.GetNeighborBlocksRequest()
    client.sendRequest(req, function (err, res) {
      if (err) {
        callback(err)
      } else {
        __(res.neighbors).each(function (blockId, faceIndex) {
          var block = new Block(blockId, 1, BlockTypes.UNKNOWN)
          block._faceIndex = parseInt(faceIndex, 10)
          enqueuePendingBlock(block)
        })
        callback(null)
      }
    })
  }

  function upgradeNextPendingClassicBlock(callback) {
    debug('upgradeNextPendingClassicBlock')
    assert.equal(client.getProtocol(), ClassicProtocol, 'Must be in OS3 mode.')
    var nextBlock = dequeuePendingBlock()
    if (nextBlock) {
      setTargetBlock(nextBlock)
      async.series([
        flashBootstrapToTargetBlock,
        jumpToDiscovery,
        discoverTargetImagoBlock,
        jumpToImago,
        flashUpgradeToTargetBlock,
        checkTargetBlockComplete
      ], callback)
    } else {
      setTargetBlock(null)
      callback(null)
    }
  }

  function enqueuePendingImagoBlocks(callback) {
    debug('enqueuePendingImagoBlocks')
    var protocol = client.getProtocol()
    assert.equal(protocol, ImagoProtocol, 'Must be in OS4 mode.')
    var req = new ImagoProtocol.messages.GetNeighborBlocksRequest()
    client.sendRequest(req, function (err, res) {
      if (err) {
        callback(err)
      } else {
        var getModeTasks = __(res.neighbors).map(function (blockId, faceIndex) {
          return function (callback) {
            var req = new ImagoProtocol.Block.messages.GetConfigurationRequest(blockId)
            client.sendBlockRequest(req, function (err, res) {
              if (err) {
                // Note: This is a non-fatal error, so send a successful
                // result back to the callback so the upgrade process can
                // continue. However, still emit the error so it can still
                // be noticed by the app.
                callback(null)
                self.emit('error', err)
              } else {
                // Only enqueue pending imago blocks if they are in bootloader.
                if (res.mode === 0 && !findPendingBlockById(blockId)) {
                  var block = new Block(blockId, 1, BlockTypes.UNKNOWN)
                  block._faceIndex = parseInt(faceIndex, 10)
                  enqueuePendingBlock(block)
                }
                callback(null)
              }
            })
          }
        })
        async.series(getModeTasks, callback)
      }
    })
  }

  function upgradeNextPendingImagoBlock(callback) {
    debug('upgradeNextPendingImagoBlock')
    assert.equal(client.getProtocol(), ImagoProtocol, 'Must be in OS4 mode.')
    var nextBlock = dequeuePendingBlock()
    if (nextBlock) {
      targetBlock = nextBlock
      self.emit('changeTargetBlock', targetBlock)
      async.series([
        flashUpgradeToTargetBlock,
        checkTargetBlockComplete
      ], callback)
    } else {
      targetBlock = null
      self.emit('changeTargetBlock', targetBlock)
      callback(null)
    }
  }

  function fetchUnknownPendingBlockTypes(callback) {
    debug('fetchUnknownPendingBlockTypes')
    var unknownBlocks = filterUnknownPendingBlocks()
    if (0 === unknownBlocks.length) {
      callback(null)
    } else {
      var service = new InfoService()

      service.on('info', function (info, block) {
        block._blockType = Block.blockTypeForId(info.blockTypeId)
        block._mcuType = Block.mcuTypeForId(info.mcuTypeId)
      })

      service.fetchBlockInfo(unknownBlocks, function (err) {
        service.removeAllListeners('info')
        self.emit('changePendingBlocks', pendingBlocks)
        callback(err)
      })
    }
  }

  function flashBootstrapToTargetBlock(callback) {
    debug('flashBootstrapToTargetBlock')
    assert.equal(client.getProtocol(), ClassicProtocol, 'Must be in OS3 mode.')
    assert(targetBlock, 'Target block must be set.')
    var blockType = targetBlock.getBlockType()
    var hex = HexFiles[blockType.name]['bootstrap']
    var program = new ClassicProgram(hex)
    if (program.valid) {
      self.emit('flashBootstrapToTargetBlock', targetBlock)
      var flash = new ClassicFlash(client, {
        skipSafeCheck: true
      })
      flash.programToBlock(program, targetBlock, function (err) {
        flash.removeListener('progress', onProgress)
        callback(err)
      })
      flash.on('progress', onProgress)
      function onProgress(e) {
        self.emit('progress', e)
      }
    } else {
      callback(new Error('Program invalid.'))
    }
  }

  function discoverTargetImagoBlock(callback) {
    debug('discoverTargetImagoBlock')
    assert.equal(client.getProtocol(), BootstrapProtocol, 'Must be in discovery mode.')
    assert(targetBlock, 'Target block must be set.')
    var timer = setTimeout(function () {
      client.removeListener('event', onBlockFoundEvent)
      callback(new Error('Failed to discover target OS4 block.'))
    }, 5000)
    client.on('event', onBlockFoundEvent)
    function onBlockFoundEvent(e) {
      if (e instanceof BootstrapProtocol.messages.BlockFoundEvent) {
        if (e.firmwareType === 1 && e.faceIndex === targetBlock.getFaceIndex()) {
          clearTimeout(timer)
          client.removeListener('event', onBlockFoundEvent)
          callback(null)
        }
      }
    }
  }

  function flashUpgradeToTargetBlock(callback) {
    debug('flashUpgradeToTargetBlock')
    assert.equal(client.getProtocol(), ImagoProtocol, 'Must be in OS4 mode.')
    assert(targetBlock, 'Target block must be set.')
    var blockType = targetBlock.getBlockType()
    var hex = HexFiles[blockType.name]['application']
    var program = new ImagoProgram(hex)
    if (program.valid) {
      self.emit('flashUpgradeToTargetBlock', targetBlock)
      var flash = new ImagoFlash(client, {
        skipSafeCheck: true
      })
      flash.programToBlock(program, targetBlock, function (err) {
        flash.removeListener('progress', onProgress)
        callback(err)
      })
      flash.on('progress', onProgress)
      function onProgress(e) {
        self.emit('progress', e)
      }
    } else {
      callback(new Error('Program invalid.'))
    }
  }

  function checkTargetBlockComplete(callback) {
    debug('checkTargetBlockComplete')
    assert(targetBlock, 'Target block must be set.')
    enqueueCompletedBlock(targetBlock)
    setTargetBlock(null)
    callback(null)
  }

  function flashUpgradeToHostBlock(callback) {
    debug('flashUpgradeToHostBlock')
    assert.equal(client.getProtocol(), ClassicProtocol, 'Must be in OS3 mode.')
    var hex = HexFiles['bluetooth']['application']
    var program = new ClassicProgram(hex)
    if (program.valid) {
      self.emit('flashUpgradeToHostBlock', hostBlock)
      var flash = new ClassicFlash(client, {
        skipSafeCheck: true
      })
      flash.programToBlock(program, hostBlock, function (err) {
        flash.removeListener('progress', onProgress)
        if (err) {
          callback(err)
        } else {
          client.setProtocol(ImagoProtocol)
          self.emit('completeHostBlock', hostBlock)
          callback(null)
        }
      })
      flash.on('progress', onProgress)
      function onProgress(e) {
        self.emit('progress', e)
      }
    } else {
      callback(new Error('Program invalid.'))
    }
  }

  function wait(timeout) {
    return function (callback) {
      debug('waiting...')
      setTimeout(callback, timeout)
    }
  }

  function findPendingBlockById(blockId) {
    return __(pendingBlocks).find(function (pendingBlock) {
      return blockId === pendingBlock.getBlockId()
    })
  }

  function findCompletedBlockById(blockId) {
    return __(completedBlocks).find(function (completedBlock) {
      return blockId === completedBlock.getBlockId()
    })
  }

  function filterUnknownPendingBlocks() {
    return __(pendingBlocks).filter(function (block) {
      return block.getBlockType() === BlockTypes.UNKNOWN
    })
  }
}

function retry(options, fn) {
  return async.retry.bind(null, options, fn)
}

util.inherits(Upgrade, events.EventEmitter)
module.exports = Upgrade
module.exports.FirmwareTypes = FirmwareTypes
