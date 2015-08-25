var assert = require('assert')
var util = require('util')
var events = require('events')
var fs = require('fs')
var async = require('async')
var ClassicProtocol = require('../protocol/classic')
var ClassicProgram = ClassicProtocol.Program
var ClassicFlash = ClassicProtocol.Flash
var ImagoProtocol = require('../protocol/imago')
var ImagoProgram = ImagoProtocol.Program
var ImagoFlash = ImagoProtocol.Flash
var UpgradeProtocol = require('../protocol/bootstrap/upgrade')
var Block = require('../block')
var BlockTypes = require('../blockTypes')
var MCUTypes = require('../mcuTypes')
var InfoService = require('../services/info')
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
    detectFirmwareType(function (err, firmwareType) {
      if (err) {
        callback(err)
      } else {
        callback(null, (FirmwareTypes.IMAGO !== firmwareType), firmwareType)
      }
    })
  }

  function detectFirmwareType(callback) {
    console.log('detectFirmwareType')
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
        client.setProtocol(UpgradeProtocol)
        callback(null, FirmwareTypes.BOOTSTRAP)
      } else {
        // Otherwise, the cubelet has classic firmware.
        callback(null, FirmwareTypes.CLASSIC)
      }
    })
  }

  this.start = function (callback) {
    console.log('start')
    if (running) {
      callback(new Error('Upgrade already started.'))
    } else {
      running = true
      finished = false
      async.series([
        jumpToClassic,
        discoverHostBlock,
        flashBootstrapToHostBlockIfNeeded,
        startBlockUpgrades
      ], callback)
    }
  }

  function discoverHostBlock(callback) {
    console.log('discoverHostBlock')
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

  function flashBootstrapToHostBlockIfNeeded(callback) {
    detectFirmwareType(function (err, firmwareType) {
      if (err) {
        callback(err)
      } else if (FirmwareTypes.CLASSIC === firmwareType) {
        flashBootstrapToHostBlock(callback)
      } else {
        callback(null)
      }
    })
  }

  function flashBootstrapToHostBlock(callback) {
    console.log('flashBootstrapToHostBlock')
    assert.equal(client.getProtocol(), ClassicProtocol, 'Must be in OS3 mode.')
    var hex = fs.readFileSync('./upgrade/hex/bluetooth_bootstrap.hex')
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
          client.setProtocol(UpgradeProtocol)
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
      if (e instanceof UpgradeProtocol.messages.SkipDisconnectEvent) {
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
      retry({ times: 5, interval: 5000 }, waitForDisconnect),
      retry({ times: 5, interval: 5000 }, waitForReconnect)
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
      if (e instanceof UpgradeProtocol.messages.DisconnectFailedEvent) {
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
    console.log('enqueuePendingBlock')
    if (!findPendingBlockById(block.getBlockId())) {
      pendingBlocks.unshift(block)
      self.emit('changePendingBlocks', pendingBlocks)
      return true
    } else {
      return false
    }
  }

  function dequeuePendingBlock() {
    console.log('dequeuePendingBlock')
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
    console.log('setTargetBlock')
    targetBlock = block
    self.emit('changeTargetBlock', targetBlock)
  }

  this.getCompletedBlocks = function () {
    return completedBlocks
  }

  function enqueueCompletedBlock(block) {
    console.log('enqueueCompletedBlock')
    if (!findCompletedBlockById(block.getBlockId())) {
      completedBlocks.unshift(block)
      self.emit('completeBlock', block)
      self.emit('changeCompletedBlocks', completedBlocks)
      return true
    } else {
      return false
    }
  }

  function startBlockUpgrades(callback) {
    console.log('startBlockUpgrades')
    async.until(function () {
      return finished
    }, function (next) {
      async.series([
        jumpToDiscovery,
        discoverTargetFaces,
        waitForFinish(2500)
      ], next)
    }, callback)
  }

  function jumpToClassic(callback) {
    console.log('jumpToClassic')
    var protocol = client.getProtocol()
    if (ClassicProtocol === protocol) {
      callback(null)
    } else if (UpgradeProtocol === protocol) {
      var req = new UpgradeProtocol.messages.SetBootstrapModeRequest(0)
      client.sendRequest(req, function (err, res) {
        if (err) {
          callback(err)
        } else if (res.mode !== 0) {
          callback(new Error('Failed to jump to OS3 mode.'))
        } else {
          client.setProtocol(ClassicProtocol)
          callback(null)
        }
      })
    } else {
      callback(new Error('Must not jump to OS3 mode from OS4 mode.'))
    }
  }

  function jumpToImago(callback) {
    console.log('jumpToImago')
    var protocol = client.getProtocol()
    if (ImagoProtocol === protocol) {
      callback(null)
    } else if (UpgradeProtocol === protocol) {
      var req = new UpgradeProtocol.messages.SetBootstrapModeRequest(1)
      client.sendRequest(req, function (err, res) {
        if (err) {
          callback(err)
        } else if (res.mode !== 1) {
          callback(new Error('Failed to jump to OS4 mode.'))
        } else {
          client.setProtocol(ImagoProtocol)
          callback(null)
        }
      })
    } else {
      callback(new Error('Must not jump to OS4 mode from OS3 mode.'))
    }
  }

  function jumpToDiscovery(callback) {
    console.log('jumpToDiscovery')
    var protocol = client.getProtocol()
    if (UpgradeProtocol === protocol) {
      callback(null)
    } else {
      var ResetCommand = protocol.messages.ResetCommand
      client.sendCommand(new ResetCommand())
      setTimeout(function () {
        client.setProtocol(UpgradeProtocol)
        var timer = setTimeout(function () {
          client.removeListener('event', waitForBlockEvent)
          client.setProtocol(protocol)
          callback(new Error('Failed to jump to discovery mode.'))
        }, 2500)
        client.on('event', waitForBlockEvent)
        function waitForBlockEvent(e) {
          if (e instanceof UpgradeProtocol.messages.BlockFoundEvent) {
            client.removeListener('event', waitForBlockEvent)
            if (timer) {
              clearTimeout(timer)
              callback(null)
            }
          }
        }
      }, 500)
    }
  }

  function discoverTargetFaces(callback) {
    console.log('discoverTargetFaces')
    assert.equal(client.getProtocol(), UpgradeProtocol, 'Must be in discovery mode.')
    targetFaces = {}
    client.on('event', onBlockFoundEvent)
    function onBlockFoundEvent(e) {
      if (e instanceof UpgradeProtocol.messages.BlockFoundEvent) {
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
      console.log('targetFaces', targetFaces)
      var classicFaces = __(targetFaces).where({ firmwareType: 0 })
      var imagoFaces = __(targetFaces).where({ firmwareType: 1 })
      if (classicFaces.length > 0) {
        console.log('classic faces > 0')
        async.series([
          jumpToClassic,
          enqueuePendingClassicBlocks,
          fetchUnknownPendingBlockTypes,
          upgradeNextPendingClassicBlock
        ], callback)
      } else if (imagoFaces.length > 0) {
        console.log('imago faces > 0')
        async.series([
          jumpToImago,
          enqueuePendingImagoBlocks,
          fetchUnknownPendingBlockTypes,
          upgradeNextPendingImagoBlock
        ], callback)
      } else {
        console.log('no faces')
        callback(null)
      }
    }, 2500)
  }

  function enqueuePendingClassicBlocks(callback) {
    console.log('enqueuePendingClassicBlocks')
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
    console.log('upgradeNextPendingClassicBlock')
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
    console.log('enqueuePendingImagoBlocks')
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
                callback(err)
              } else {
                // Only enqueue pending imago blocks if they are in bootloader.
                if (res.mode === 0 && !findPendingBlockById(blockId)) {
                  var block = new Block(blockId, 1, BlockTypes.UNKNOWN)
                  block._faceIndex = parseInt(faceIndex, 10)
                  enqueuePendingBlock(block)
                }
              }
            })
          }
        })
        async.series(getModeTasks, callback)
      }
    })
  }

  function upgradeNextPendingImagoBlock(callback) {
    console.log('upgradeNextPendingImagoBlock')
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
    console.log('fetchUnknownPendingBlockTypes')
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
        self.emit('changePendingBlocks')
        callback(err)
      })
    }
  }

  function flashBootstrapToTargetBlock(callback) {
    console.log('flashBootstrapToTargetBlock')
    assert.equal(client.getProtocol(), ClassicProtocol, 'Must be in OS3 mode.')
    assert(targetBlock, 'Target block must be set.')
    var blockType = targetBlock.getBlockType()
    var hex = fs.readFileSync('./upgrade/hex/pic_bootstrap/' + blockType.name + '_bootstrap.hex')
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
    console.log('discoverTargetImagoBlock')
    assert.equal(client.getProtocol(), UpgradeProtocol, 'Must be in discovery mode.')
    assert(targetBlock, 'Target block must be set.')
    var timer = setTimeout(function () {
      client.removeListener('event', onBlockFoundEvent)
      callback(new Error('Failed to discover target OS3 block.'))
    }, 5000)
    client.on('event', onBlockFoundEvent)
    function onBlockFoundEvent(e) {
      if (e instanceof UpgradeProtocol.messages.BlockFoundEvent) {
        if (e.firmwareType === 1 && e.faceIndex === targetBlock.getFaceIndex()) {
          clearTimeout(timer)
          client.removeListener('event', onBlockFoundEvent)
          callback(null)
        }
      }
    }
  }

  function flashUpgradeToTargetBlock(callback) {
    console.log('flashUpgradeToTargetBlock')
    assert.equal(client.getProtocol(), ImagoProtocol, 'Must be in OS4 mode.')
    assert(targetBlock, 'Target block must be set.')
    var blockType = targetBlock.getBlockType()
    var hex = fs.readFileSync('./upgrade/hex/applications/' + blockType.name + '.hex')
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
    console.log('checkTargetBlockComplete')
    assert(targetBlock, 'Target block must be set.')
    enqueueCompletedBlock(targetBlock)
    setTargetBlock(null)
    callback(null)
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

  this.finish = function (callback) {
    console.log('finish')
    if (running) {
      process.nextTick(function () {
        finished = true
      })
      self.on('finishBlockUpgrades', onFinishBlockUpgrades)
      function onFinishBlockUpgrades() {
        self.removeListener('finishBlockUpgrades', onFinishBlockUpgrades)
        async.series([
          flashUpgradeToHostBlock
        ], function (err) {
          if (err) {
            callback(err)
          } else {
            callback(null)
            self.emit('finish')
          }
        })
      }
    }
  }

  function flashUpgradeToHostBlock(callback) {
    console.log('flashUpgradeToHostBlock')
    assert.equal(client.getProtocol(), ClassicProtocol, 'Must be in OS3 mode.')
    var hex = fs.readFileSync('./upgrade/hex/bluetooth_bootstrap.hex')
    var program = new Program(hex)
    if (program.valid) {
      self.emit('flashBootstrapToHostBlock', hostBlock)
      var flash = new Flash(client, {
        skipSafeCheck: true
      })
      flash.programToBlock(program, hostBlock, function (err) {
        flash.removeListener('progress', onProgress)
        if (err) {
          callback(err)
        } else {
          async.series([
            retry({ times: 1, interval: 5000 }, waitForDisconnect),
            retry({ times: 1, interval: 5000 }, waitForReconnect)
          ], callback)
        }
      })
      flash.on('progress', onProgress)
      function onProgress(e) {
        self.emit('progress', e)
      }
    } else {
      callback(new Error('Invalid program.'))
    }
  }

  function waitForFinish(timeout) {
    return function (callback) {
      console.log('Waiting for blocks...')
      setTimeout(callback, timeout)
    }
  }
}

function retry(options, fn) {
  return async.retry.bind(null, options, fn)
}

util.inherits(Upgrade, events.EventEmitter)

module.exports = Upgrade
module.exports.FirmwareTypes = FirmwareTypes